#!/usr/bin/env python3
"""
Fetch journal article metadata from OpenAlex into per-year JSON shards.

Usage:
  python fetch.py recent    # fetch works published in the last RECENT_DAYS days
  python fetch.py backfill  # full-history fetch for journals not yet backfilled
  python fetch.py all       # backfill + recent

Data layout (repo root):
  journals.json            journal list (edited via the site's admin page)
  data/<slug>/<year>.json  article shards, one per journal per year
  data/index.json          manifest consumed by the site
  data/state.json          internal state (backfill progress)
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

BASE = "https://api.openalex.org/works"
MAILTO = "wakin-leo@users.noreply.github.com"  # OpenAlex polite pool
RECENT_DAYS = 10  # overlap window so late updates to recent records get merged
# schema v2 (2026-09-18): records include best_oa_location.pdf_url as "pdf"
PER_PAGE = 200

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")

SELECT = ",".join([
    "doi", "title", "publication_date", "authorships",
    "abstract_inverted_index", "open_access", "keywords", "type",
    "best_oa_location",
])


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "toc-digest/1.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.load(resp)
        except Exception as exc:  # noqa: BLE001
            if attempt == 4:
                raise
            wait = 2 ** attempt
            print(f"  retry {attempt + 1} after error: {exc} (wait {wait}s)")
            time.sleep(wait)


def reconstruct_abstract(inverted):
    """OpenAlex stores abstracts as {word: [positions]}; rebuild the text."""
    if not inverted:
        return ""
    pos = {}
    for word, positions in inverted.items():
        for p in positions:
            pos[p] = word
    text = " ".join(pos[i] for i in sorted(pos))
    # some publishers embed a leading "Abstract" label in the field
    for label in ("Abstract ", "ABSTRACT ", "Abstract. ", "Abstract: "):
        if text.startswith(label):
            text = text[len(label):]
            break
    return text.strip()


def normalize(work):
    authors = [
        a.get("author", {}).get("display_name", "")
        for a in work.get("authorships", [])
    ]
    authors = [a for a in authors if a]
    oa = work.get("open_access") or {}
    kws = [k.get("display_name", "") for k in (work.get("keywords") or [])[:8]]
    kws = [k for k in kws if k]
    doi = work.get("doi") or ""
    best_oa = work.get("best_oa_location") or {}
    return {
        "doi": doi.replace("https://doi.org/", ""),
        "t": work.get("title") or "",
        "a": authors,
        "d": work.get("publication_date") or "",
        "abs": reconstruct_abstract(work.get("abstract_inverted_index")),
        "oa": oa.get("oa_status") or "closed",
        "url": oa.get("oa_url") or (("https://doi.org/" + doi.replace("https://doi.org/", "")) if doi else ""),
        "pdf": best_oa.get("pdf_url") or "",
        "k": kws,
    }


def fetch_works(issns, from_date=None, to_date=None):
    flt = "primary_location.source.issn:" + "|".join(issns)
    flt += ",type:article|review"
    if from_date:
        flt += f",from_publication_date:{from_date}"
    if to_date:
        flt += f",to_publication_date:{to_date}"
    params = {
        "filter": flt,
        "per-page": PER_PAGE,
        "cursor": "*",
        "mailto": MAILTO,
        "select": SELECT,
    }
    total = 0
    while True:
        url = BASE + "?" + urllib.parse.urlencode(params)
        payload = http_get(url)
        results = payload.get("results", [])
        for w in results:
            yield w
        total += len(results)
        nxt = payload.get("meta", {}).get("next_cursor")
        if not results or not nxt:
            break
        params["cursor"] = nxt
        time.sleep(0.12)  # stay well under the 10 req/s limit
    return total


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def upsert_works(slug, works):
    """Merge normalized works into per-year shards. Returns count merged."""
    by_year = {}
    for w in works:
        if not w["d"] or not w["doi"]:
            continue
        by_year.setdefault(w["d"][:4], []).append(w)
    n = 0
    for year, items in by_year.items():
        path = os.path.join(DATA, slug, f"{year}.json")
        shard = load_json(path, [])
        idx = {x["doi"]: i for i, x in enumerate(shard)}
        for w in items:
            if w["doi"] in idx:
                shard[idx[w["doi"]]] = w
            else:
                shard.append(w)
            n += 1
        shard.sort(key=lambda x: x["d"], reverse=True)
        save_json(path, shard)
    return n


def rebuild_manifest(journals):
    manifest = {"updated": date.today().isoformat(), "journals": []}
    for j in journals:
        jdir = os.path.join(DATA, j["slug"])
        years = {}
        if os.path.isdir(jdir):
            for fn in os.listdir(jdir):
                if fn.endswith(".json") and fn[:4].isdigit():
                    shard = load_json(os.path.join(jdir, fn), [])
                    years[fn[:4]] = len(shard)
        entry = dict(j)
        entry["years"] = dict(sorted(years.items(), reverse=True))
        manifest["journals"].append(entry)
    save_json(os.path.join(DATA, "index.json"), manifest)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    journals = load_json(os.path.join(ROOT, "journals.json"), {"journals": []})["journals"]
    state = load_json(os.path.join(DATA, "state.json"), {"backfill_done": {}})

    if mode in ("backfill", "all"):
        for j in journals:
            if state["backfill_done"].get(j["slug"]):
                continue
            print(f"[backfill] {j['name']} ...", flush=True)
            works = [normalize(w) for w in fetch_works(j["issns"])]
            n = upsert_works(j["slug"], works)
            state["backfill_done"][j["slug"]] = True
            save_json(os.path.join(DATA, "state.json"), state)
            print(f"  -> {n} records merged")

    if mode in ("recent", "all"):
        from_d = (date.today() - timedelta(days=RECENT_DAYS)).isoformat()
        for j in journals:
            if not state["backfill_done"].get(j["slug"]):
                continue  # backfill first
            print(f"[recent] {j['name']} (since {from_d}) ...", flush=True)
            works = [normalize(w) for w in fetch_works(j["issns"], from_date=from_d)]
            n = upsert_works(j["slug"], works)
            print(f"  -> {n} records merged")

    rebuild_manifest(journals)
    print("manifest rebuilt")


if __name__ == "__main__":
    main()

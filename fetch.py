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
UNPAYWALL = "https://api.unpaywall.org/v2/"
UNPAYWALL_EMAIL = "zhan_leo@163.com"  # Unpaywall requires a contact email
RECENT_DAYS = 10  # overlap window so late updates to recent records get merged
# schema v2 (2026-09-18): records include best_oa_location.pdf_url as "pdf"
# schema v3 (2026-09-18): pdf now also tries every OpenAlex location, then
#                         Unpaywall as a fallback for non-closed works
PER_PAGE = 200

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")

SELECT = ",".join([
    "doi", "title", "publication_date", "authorships",
    "abstract_inverted_index", "open_access", "keywords", "type",
    "best_oa_location", "locations",
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


def pdf_from_openalex(work):
    """First pdf_url found in best_oa_location, then any other location."""
    best = (work.get("best_oa_location") or {}).get("pdf_url")
    if best:
        return best
    for loc in work.get("locations") or []:
        url = (loc or {}).get("pdf_url")
        if url:
            return url
    return ""


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
    return {
        "doi": doi.replace("https://doi.org/", ""),
        "t": work.get("title") or "",
        "a": authors,
        "d": work.get("publication_date") or "",
        "abs": reconstruct_abstract(work.get("abstract_inverted_index")),
        "oa": oa.get("oa_status") or "closed",
        "url": oa.get("oa_url") or (("https://doi.org/" + doi.replace("https://doi.org/", "")) if doi else ""),
        "pdf": pdf_from_openalex(work),
        "k": kws,
    }


def unpaywall_pdf(doi):
    """Ask Unpaywall for a pdf url; '' when none or on any failure."""
    url = UNPAYWALL + urllib.parse.quote(doi) + "?email=" + urllib.parse.quote(UNPAYWALL_EMAIL)
    try:
        payload = http_get(url)
    except Exception as exc:  # noqa: BLE001
        print(f"  unpaywall lookup failed for {doi}: {exc}")
        return ""
    best = (payload.get("best_oa_location") or {}).get("url_for_pdf")
    if best:
        return best
    for loc in payload.get("oa_locations") or []:
        url = (loc or {}).get("url_for_pdf")
        if url:
            return url
    return ""


def enrich_pdfs(works):
    """Fill empty pdf fields via Unpaywall (only for non-closed works)."""
    todo = [w for w in works if not w["pdf"] and w["oa"] != "closed" and w["doi"]]
    if not todo:
        return 0
    print(f"  unpaywall fallback for {len(todo)} works ...", flush=True)
    filled = 0
    for i, w in enumerate(todo):
        pdf = unpaywall_pdf(w["doi"])
        if pdf:
            w["pdf"] = pdf
            filled += 1
        if (i + 1) % 100 == 0:
            print(f"  unpaywall progress {i + 1}/{len(todo)}, filled {filled}", flush=True)
        time.sleep(0.1)  # Unpaywall fair-use: stay well under 100k/day pacing
    print(f"  unpaywall filled {filled}/{len(todo)}")
    return filled


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


def source_stats(issn):
    """OpenAlex journal-level metrics (2yr mean citedness, h-index)."""
    url = ("https://api.openalex.org/sources/issn:" + urllib.parse.quote(issn)
           + "?select=summary_stats&mailto=" + MAILTO)
    try:
        s = http_get(url).get("summary_stats") or {}
    except Exception as exc:  # noqa: BLE001
        print(f"  source stats failed for {issn}: {exc}")
        return None
    m2 = s.get("2yr_mean_citedness")
    return {"m2": round(m2, 1) if m2 is not None else None, "h": s.get("h_index")}


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
        for issn in j.get("issns", []):
            st = source_stats(issn)
            if st:
                entry["stats"] = st
                break
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
            enrich_pdfs(works)
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
            enrich_pdfs(works)
            n = upsert_works(j["slug"], works)
            print(f"  -> {n} records merged")

    rebuild_manifest(journals)
    print("manifest rebuilt")


if __name__ == "__main__":
    main()

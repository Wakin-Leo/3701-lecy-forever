"""One-shot backfill: embed all existing titles into data/emb/ shards.
Resumable: already-embedded DOIs are skipped, so just re-run until it
prints TOTAL_PENDING=0. Requires SILICONFLOW_API_KEY in the environment.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch  # noqa: E402


def pending_count(journals):
    n = 0
    for j in journals:
        jdir = os.path.join(fetch.DATA, j["slug"])
        if not os.path.isdir(jdir):
            continue
        for fn in os.listdir(jdir):
            if not (fn.endswith(".json") and fn[:4].isdigit()):
                continue
            have = set(fetch.load_json(fetch.emb_path(j["slug"], fn[:4]), {"items": {}})["items"])
            for w in fetch.load_json(os.path.join(jdir, fn), []):
                if w.get("doi") and w.get("t") and w["doi"] not in have:
                    n += 1
    return n


def main():
    journals = fetch.load_json(os.path.join(fetch.ROOT, "journals.json"), {"journals": []})["journals"]
    key = fetch.EMB_KEY
    if not key:
        print("SILICONFLOW_API_KEY not set")
        sys.exit(1)
    deadline = time.time() + float(os.environ.get("EMB_BUDGET_SEC", "240"))
    for j in journals:
        if time.time() > deadline:
            break
        n = fetch.embed_journal(j["slug"], key)
        if n:
            print(f"[{j['slug']}] embedded {n}", flush=True)
    print("TOTAL_PENDING=%d" % pending_count(journals), flush=True)


if __name__ == "__main__":
    main()

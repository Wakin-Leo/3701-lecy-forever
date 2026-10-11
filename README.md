# Daily Digest

Personal journal table-of-contents aggregator. Metadata is fetched daily from
[OpenAlex](https://openalex.org) (CC0) by `fetch.py`; the static site reads the
JSON shards under `data/`.

- `journals.json` — watched journals (edit via the site's admin page)
- `data/` — generated article shards, one per journal per year
- `.github/workflows/daily.yml` — daily scheduled fetch + commit

Maintenance and local preview: see [MAINTENANCE.md](MAINTENANCE.md).
Offline validation, isolated preview, recovery snapshots, and read-only hosting
checks are available under `tools/`; no frontend build or package install is needed.

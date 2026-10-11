#!/usr/bin/env python3
"""Read-only, offline baseline checks for Academic Daily Digest.

Only aggregate counts are printed/saved. Personal text, DOIs, journal names,
configuration values, tokens and exception text never enter the report.
This script does not import or run the fetchers and creates no bytecode cache.
Exit codes: 0 = passed (warnings may exist), 1 = errors, 2 = invocation/report error.
"""

import argparse
import base64
import binascii
import json
import re
import shutil
import subprocess
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path


SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
YEAR = re.compile(r"\d{4}\Z")
DOI = re.compile(r"10\.\d{4,9}/\S+\Z", re.IGNORECASE)
ISSN = re.compile(r"\d{4}-\d{3}[\dX]\Z", re.IGNORECASE)
EXPECTED_DIM = 1024  # int8 bytes, matching fetch.py and the browser decoder


def iso_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def string_list(value):
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


class Audit:
    def __init__(self, root, node):
        self.root = root
        self.node = node
        self.checks = []
        self.json_stats = Counter()

    def add(self, name, errors=0, warnings=0, **counts):
        self.checks.append({
            "check": name,
            "status": "ERROR" if errors else "WARNING" if warnings else "PASS",
            "errors": errors,
            "warnings": warnings,
            "counts": counts,
        })

    def load(self, path, required=True):
        if not path.is_file():
            self.json_stats["missing_required" if required else "optional_absent"] += 1
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            self.json_stats["parsed"] += 1
            return value
        except (OSError, UnicodeError, json.JSONDecodeError):
            self.json_stats["unreadable_or_invalid"] += 1
            return None

    def syntax(self):
        node = self.node or shutil.which("node")
        if not node:
            self.add("javascript_syntax_not_checked", warnings=1, node_unavailable=1)
        else:
            try:
                result = subprocess.run(
                    [node, "--check", str(self.root / "app.js")],
                    cwd=self.root, capture_output=True, timeout=30, check=False,
                )
                self.add("javascript_syntax", errors=int(result.returncode != 0))
            except (OSError, subprocess.TimeoutExpired):
                self.add("javascript_syntax_not_checked", warnings=1, runtime_unavailable=1)
        errors = 0
        python_files = ["fetch.py", "embed_backfill.py"] + [str(path.relative_to(self.root)) for path in sorted((self.root / "tools").glob("*.py"))]
        for name in python_files:
            try:
                compile((self.root / name).read_text(encoding="utf-8-sig"), name, "exec")
            except (OSError, UnicodeError, SyntaxError):
                errors += 1
        self.add("python_syntax", errors=errors, files=len(python_files))

    def catalogue(self, doc, manifest=False):
        problems = 0
        if not isinstance(doc, dict) or not isinstance(doc.get("journals"), list):
            return {}, 1
        if manifest and not iso_date(doc.get("updated")):
            problems += 1
        result = {}
        for item in doc["journals"]:
            if not isinstance(item, dict):
                problems += 1
                continue
            slug = item.get("slug")
            if not isinstance(slug, str) or not SLUG.fullmatch(slug):
                problems += 1
                continue
            if slug in result:
                problems += 1
            result[slug] = item
            if not isinstance(item.get("name"), str) or not item["name"].strip():
                problems += 1
            issns = item.get("issns")
            if not string_list(issns) or not issns or any(not ISSN.fullmatch(v) for v in issns):
                problems += 1
            if manifest:
                years = item.get("years")
                if not isinstance(years, dict):
                    problems += 1
                else:
                    problems += sum(
                        not YEAR.fullmatch(y) or type(n) is not int or n < 0
                        for y, n in years.items()
                    )
        return result, problems

    def configuration(self):
        journals = self.load(self.root / "journals.json")
        manifest = self.load(self.root / "data/index.json")
        config = self.load(self.root / "site-config.json")
        catalog, cat_errors = self.catalogue(journals)
        indexed, index_errors = self.catalogue(manifest, manifest=True)
        config_errors = int(not isinstance(config, dict))
        if isinstance(config, dict):
            config_errors += int(not isinstance(config.get("title"), str))
            config_errors += int(not isinstance(config.get("translate"), bool))
            password = config.get("password_sha256")
            config_errors += int(not isinstance(password, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", password))
        self.add("key_json_shapes", errors=cat_errors + index_errors + config_errors)
        mismatch = len(set(catalog) ^ set(indexed))
        for slug in set(catalog) & set(indexed):
            mismatch += int(catalog[slug].get("name") != indexed[slug].get("name"))
            mismatch += int(catalog[slug].get("issns") != indexed[slug].get("issns"))
        self.add("journal_manifest_alignment", errors=mismatch, journals=len(catalog))
        try:
            source = (self.root / "app.js").read_text(encoding="utf-8-sig")
            field_match = re.search(r"var\s+JFIELD\s*=\s*(\{.*?\})\s*;", source, re.DOTALL)
            order_match = re.search(r"var\s+FIELD_ORDER\s*=\s*(\[.*?\])\s*;", source, re.DOTALL)
            fields = json.loads(field_match.group(1)) if field_match else None
            order = json.loads(order_match.group(1)) if order_match else None
            if not isinstance(fields, dict) or not string_list(order):
                raise ValueError
            absent = len(set(catalog) - set(fields))
            obsolete = len(set(fields) - set(catalog))
            unknown = sum(v not in order for v in fields.values())
            self.add("frontend_journal_field_alignment", errors=absent + unknown,
                     warnings=obsolete, unmapped_journals=absent, obsolete_mappings=obsolete)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            self.add("frontend_journal_field_alignment", errors=1)
        return catalog, indexed

    def article_shards(self, catalog, indexed):
        counts = Counter()
        shard_dois = {}
        eligible_dois = {}
        all_dois = set()
        actual_years = {}
        data_dir = self.root / "data"
        for directory in sorted(data_dir.iterdir()) if data_dir.is_dir() else []:
            if not directory.is_dir() or directory.name == "emb":
                continue
            slug = directory.name
            if slug not in catalog:
                counts["retained_inactive_journal_directories"] += 1
            years = {}
            for path in sorted(directory.glob("*.json")):
                year = path.stem
                if not YEAR.fullmatch(year):
                    counts["invalid_shard_filenames"] += 1
                    continue
                rows = self.load(path)
                if not isinstance(rows, list):
                    counts["invalid_shard_shapes"] += 1
                    continue
                years[year] = len(rows)
                counts["shards"] += 1
                counts["articles"] += len(rows)
                dois, eligible = set(), set()
                for row in rows:
                    if not isinstance(row, dict):
                        counts["invalid_article_shapes"] += 1
                        continue
                    doi, title, published = row.get("doi"), row.get("t"), row.get("d")
                    if not isinstance(doi, str) or not DOI.fullmatch(doi):
                        counts["invalid_doi_shapes"] += 1
                    if not isinstance(title, str):
                        counts["invalid_title_shapes"] += 1
                    elif not title.strip():
                        counts["empty_titles"] += 1
                    if not iso_date(published):
                        counts["invalid_dates"] += 1
                    elif published[:4] != year:
                        counts["date_shard_year_mismatches"] += 1
                    if isinstance(doi, str) and doi:
                        if doi in dois:
                            counts["duplicate_dois_within_shard"] += 1
                        elif doi in all_dois:
                            counts["duplicate_dois_across_shards"] += 1
                        dois.add(doi)
                        if isinstance(title, str) and title.strip():
                            eligible.add(doi)
                all_dois.update(dois)
                shard_dois[(slug, year)] = dois
                eligible_dois[(slug, year)] = eligible
            actual_years[slug] = years
        manifest_errors = 0
        for slug, journal in indexed.items():
            years = journal.get("years")
            if not isinstance(years, dict):
                continue
            actual = actual_years.get(slug, {})
            manifest_errors += len(set(years) ^ set(actual))
            manifest_errors += sum(years[y] != actual[y] for y in set(years) & set(actual))
        self.add("manifest_shard_counts", errors=manifest_errors,
                 shards=counts["shards"], articles=counts["articles"])
        error_keys = ("invalid_shard_filenames", "invalid_shard_shapes", "invalid_article_shapes",
                      "invalid_doi_shapes", "invalid_title_shapes", "invalid_dates", "date_shard_year_mismatches")
        warning_keys = ("empty_titles", "duplicate_dois_within_shard", "duplicate_dois_across_shards",
                        "retained_inactive_journal_directories")
        self.add("article_shapes_and_dates", errors=sum(counts[k] for k in error_keys),
                 warnings=sum(counts[k] for k in warning_keys), **dict(counts))
        return shard_dois, eligible_dois, all_dois, actual_years

    def embeddings(self, shard_dois, eligible_dois):
        counts = Counter()
        valid_by_shard = {}
        emb_dir = self.root / "data/emb"
        for path in sorted(emb_dir.glob("*/*.json")):
            key = (path.parent.name, path.stem)
            doc = self.load(path)
            counts["embedding_shards"] += 1
            if not isinstance(doc, dict) or not isinstance(doc.get("items"), dict):
                counts["invalid_embedding_shapes"] += 1
                continue
            if type(doc.get("dim")) is not int or doc["dim"] != EXPECTED_DIM:
                counts["invalid_dimensions"] += 1
            valid = set()
            for doi, encoded in doc["items"].items():
                counts["vectors"] += 1
                if not DOI.fullmatch(doi):
                    counts["invalid_embedding_doi_shapes"] += 1
                try:
                    if not isinstance(encoded, str):
                        raise ValueError
                    raw = base64.b64decode(encoded, validate=True)
                    if len(raw) != EXPECTED_DIM:
                        counts["invalid_vector_lengths"] += 1
                    else:
                        valid.add(doi)
                except (ValueError, binascii.Error):
                    counts["invalid_base64_vectors"] += 1
            valid_by_shard[key] = valid
            counts["vectors_without_article_in_same_shard"] += len(valid - shard_dois.get(key, set()))
        for key, eligible in eligible_dois.items():
            counts["eligible_articles"] += len(eligible)
            counts["covered_articles"] += len(eligible & valid_by_shard.get(key, set()))
        counts["pending_vectors"] = counts["eligible_articles"] - counts["covered_articles"]
        error_keys = ("invalid_embedding_shapes", "invalid_dimensions", "invalid_embedding_doi_shapes",
                      "invalid_vector_lengths", "invalid_base64_vectors")
        coverage = round(100 * counts["covered_articles"] / counts["eligible_articles"], 4) if counts["eligible_articles"] else 100.0
        self.add("embedding_integrity_and_coverage", errors=sum(counts[k] for k in error_keys),
                 warnings=counts["pending_vectors"] + counts["vectors_without_article_in_same_shard"],
                 coverage_percent=coverage, **dict(counts))

    def state(self, catalog, actual_years):
        state = self.load(self.root / "data/state.json")
        if not isinstance(state, dict) or not isinstance(state.get("backfill_done"), dict):
            self.add("backfill_state", errors=1)
            return
        done = state["backfill_done"]
        invalid = sum(type(v) is not bool for v in done.values())
        missing = sum(done.get(slug) is not True for slug in catalog)
        empty = sum(done.get(slug) is True and not actual_years.get(slug) for slug in catalog)
        obsolete = len(set(done) - set(catalog))
        self.add("backfill_state", errors=invalid, warnings=missing + empty + obsolete,
                 pending_journals=missing, completed_without_shards=empty, retained_inactive_states=obsolete)

    def user_data(self, all_dois):
        errors = 0
        absent_optional = 0
        missing_references = 0
        total = 0
        item_counts = {}
        canonical = {doi.lower() for doi in all_dois}
        for name in ("favorites", "highlights", "read", "diary", "anniversaries", "works"):
            required = name in {"favorites", "highlights", "read", "diary"}
            path = self.root / "user" / (name + ".json")
            if not required and not path.exists():
                absent_optional += 1  # Initialized by the site on first use.
                continue
            doc = self.load(path, required=required)
            if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
                errors += 1
                continue
            items = doc["items"]
            item_counts[name] = len(items)
            total += len(items)
            if name == "favorites" and not string_list(doc.get("categories")):
                errors += 1
            for item in items:
                if name == "read":
                    if not isinstance(item, str) or not DOI.fullmatch(item):
                        errors += 1
                    elif item.lower() not in canonical:
                        missing_references += 1
                    continue
                if not isinstance(item, dict):
                    errors += 1
                    continue
                if name in {"favorites", "highlights"}:
                    doi = item.get("doi")
                    if not isinstance(doi, str) or not DOI.fullmatch(doi):
                        errors += 1
                    elif doi.lower() not in canonical:
                        missing_references += 1
                    errors += int(not isinstance(item.get("t"), str))
                    errors += int(not string_list(item.get("a")))
                    errors += int(not iso_date(item.get("d")))
                fields = {"favorites": ("cat", "ts"), "highlights": ("text", "ts"),
                          "diary": ("text", "ts"), "anniversaries": ("name",),
                          "works": ("id", "type", "ts")}[name]
                errors += sum(not isinstance(item.get(field), str) for field in fields)
                if name == "anniversaries":
                    errors += int(not iso_date(item.get("date")))
                    errors += int(type(item.get("yearly")) is not bool)
                if name == "works":
                    if item.get("type") == "text":
                        errors += int(not isinstance(item.get("title"), str))
                        errors += int(not isinstance(item.get("text"), str))
                    elif item.get("type") in {"photo", "art"}:
                        rel = item.get("path")
                        if not isinstance(rel, str):
                            errors += 1
                        else:
                            target = (self.root / rel).resolve()
                            errors += int(not target.is_relative_to(self.root) or not target.is_file())
                    else:
                        errors += 1
        self.add("private_user_json_shapes", errors=errors, records=total,
                 optional_uninitialized_files=absent_optional)
        self.add("user_article_references", warnings=missing_references,
                 unmatched_references=missing_references)
        notes_errors, notes_warnings = 0, 0
        for name, filename in (("highlights", "摘要笔记.md"), ("diary", "小黄豆罐头日志.md")):
            if not (self.root / "notes" / filename).is_file():
                if item_counts.get(name, 0):
                    notes_errors += 1
                else:
                    notes_warnings += 1
        self.add("generated_notes_files", errors=notes_errors, warnings=notes_warnings)

    def run(self):
        self.syntax()
        catalog, indexed = self.configuration()
        shards, eligible, dois, actual = self.article_shards(catalog, indexed)
        self.embeddings(shards, eligible)
        self.state(catalog, actual)
        self.user_data(dois)
        self.add("json_readability", errors=self.json_stats["missing_required"] + self.json_stats["unreadable_or_invalid"],
                 **dict(self.json_stats))
        statuses = Counter(check["status"] for check in self.checks)
        return {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "mode": "offline_read_only",
            "summary": {status.lower(): statuses[status] for status in ("PASS", "WARNING", "ERROR")},
            "checks": self.checks,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--node", help="Node.js executable; otherwise discovered on PATH")
    parser.add_argument("--report", type=Path, help="Optional JSON report destination (parent must exist)")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        print("ERROR: repository root is unavailable.")
        return 2
    try:
        report = Audit(root, args.node).run()
    except (OSError, ValueError, TypeError, KeyError):
        print("ERROR: audit could not complete; no file contents were printed.")
        return 2
    for check in report["checks"]:
        counts = ", ".join(f"{key}={value}" for key, value in check["counts"].items())
        print(f"{check['status']}: {check['check']}" + (f" ({counts})" if counts else ""))
    summary = report["summary"]
    print(f"Summary: {summary['pass']} passed, {summary['warning']} warnings, {summary['error']} errors.")
    if args.report:
        try:
            args.report.write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        except OSError:
            print("ERROR: report destination is unavailable.")
            return 2
    return 1 if summary["error"] else 0


if __name__ == "__main__":
    sys.exit(main())

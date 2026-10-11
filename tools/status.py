#!/usr/bin/env python3
"""Read-only Git, GitHub Pages and scheduled-fetch status. Never prints credentials."""
import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def command(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=60)
    if result.returncode:
        raise RuntimeError("Command unavailable or authentication failed")
    return result.stdout.strip()


def api(path):
    return json.loads(command(["gh", "api", path]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    report = {"generated_at_utc": datetime.now(timezone.utc).isoformat(), "read_only": True}
    try:
        report["local"] = {
            "head": command(["git", "rev-parse", "HEAD"], root),
            "branch": command(["git", "branch", "--show-current"], root),
            "change_count": len(command(["git", "status", "--porcelain"], root).splitlines()),
        }
    except (OSError, subprocess.TimeoutExpired, RuntimeError):
        report["local"] = {"available": False}
    base = "repos/Wakin-Leo/3701-lecy-forever"
    try:
        repo = api(base)
        report["github"] = {"available": True, "repository": repo["full_name"],
                            "private": repo["private"], "default_branch": repo["default_branch"],
                            "permissions": repo.get("permissions", {}), "pushed_at": repo["pushed_at"]}
    except (OSError, subprocess.TimeoutExpired, RuntimeError, json.JSONDecodeError):
        report["github"] = {"available": False, "reason": "Verify gh auth status; connector authentication is separate."}
    endpoints = {
        "pages": (base + "/pages", lambda d: {k: d.get(k) for k in ("status", "html_url", "build_type", "source")}),
        "daily_runs": (base + "/actions/workflows/daily.yml/runs?per_page=3", lambda d: [
            {k: r.get(k) for k in ("id", "status", "conclusion", "event", "created_at", "html_url")}
            for r in d.get("workflow_runs", [])]),
        "repository_secret_names": (base + "/actions/secrets", lambda d: [s["name"] for s in d.get("secrets", [])]),
    }
    if report["github"]["available"]:
        for name, (endpoint, select) in endpoints.items():
            try:
                report[name] = select(api(endpoint))
            except (OSError, subprocess.TimeoutExpired, RuntimeError, json.JSONDecodeError):
                report[name] = {"available": False, "reason": "Endpoint unavailable or permission not granted."}
    print(json.dumps(report, ensure_ascii=True, indent=2))
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if report["github"]["available"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

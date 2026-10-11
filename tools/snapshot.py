#!/usr/bin/env python3
"""Create local recovery files; never changes the repository or pushes data."""
import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--output", type=Path, help="local backup directory; defaults to ../work/backups")
    args = parser.parse_args()
    root = args.root.resolve()
    output = (args.output or root.parent / "work" / "backups").resolve()
    if output.is_relative_to(root):
        parser.error("Keep backup files outside the repository to avoid public uploads.")
    try:
        revision = git(root, "rev-parse", "HEAD").decode().strip()
        names = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").decode("utf-8").split("\0")
        status = git(root, "status", "--porcelain").decode("utf-8").splitlines()
    except subprocess.CalledProcessError:
        parser.error("--root must be an accessible Git working tree")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output.mkdir(parents=True, exist_ok=True)
    stem = f"{stamp}-{revision[:8]}"
    bundle = output / (stem + ".bundle")
    archive = output / (stem + ".zip")
    manifest = output / (stem + ".json")
    subprocess.run(["git", "-C", str(root), "bundle", "create", str(bundle), "--all"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    entries = []
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as zipped:
        for name in sorted(set(filter(None, names))):
            path = (root / name).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                continue
            zipped.write(path, name)
            entries.append({"path": name, "sha256": digest(path), "bytes": path.stat().st_size})
    subprocess.run(["git", "-C", str(root), "bundle", "verify", str(bundle)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with zipfile.ZipFile(archive) as zipped:
        bad = zipped.testzip()
        if bad:
            raise RuntimeError("Backup archive integrity check failed")
    payload = {"created_utc": stamp, "head": revision, "worktree_changes": status,
               "files": entries, "bundle": {"name": bundle.name, "sha256": digest(bundle)},
               "archive": {"name": archive.name, "sha256": digest(archive)}}
    manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"snapshot": stem, "file_count": len(entries), "bundle_verified": True,
                      "archive_verified": True, "directory": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"Snapshot failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)

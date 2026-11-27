#!/usr/bin/env python3
"""Rebuild the pinned Rust oracle and verify or regenerate expected corpus output.
Normal Vitest runs only read corpus.json and need neither Rust nor network access.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--write", action="store_true", help="Regenerate expected outputs from the retained oracle")
args = parser.parse_args()
root = Path(__file__).resolve().parent
for filename, expected in json.loads((root / "oracle/sha256.json").read_text()).items():
    if hashlib.sha256((root / "oracle" / filename).read_bytes()).hexdigest() != expected:
        raise SystemExit(f"Oracle source hash changed: {filename}")
corpus = json.loads((root / "corpus.json").read_text())
with tempfile.TemporaryDirectory(prefix="codex-skill-metadata-oracle-replay-") as directory:
    checkout = Path(directory)
    shutil.copytree(root / "oracle", checkout, dirs_exist_ok=True)
    subprocess.run(["cargo", "build", "--locked", "--offline"], cwd=checkout, check=True)
    requests = "".join(json.dumps({k: v for k, v in case.items() if k != "expected"}) + "\n" for case in corpus["cases"])
    response = subprocess.run([str(checkout / "target/debug/codex-skill-metadata-oracle")], input=requests, text=True, capture_output=True, check=True)
    outputs = [json.loads(line)["result"] for line in response.stdout.splitlines()]
if len(outputs) != len(corpus["cases"]):
    raise SystemExit("Oracle output count changed")
for case, output in zip(corpus["cases"], outputs):
    if args.write:
        case["expected"] = output
    elif output != case["expected"]:
        raise SystemExit(f"Oracle mismatch: {case['id']}")
if args.write:
    (root / "corpus.json").write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n")
print(f"Verified {len(outputs)} cases against the retained pinned Rust oracle")

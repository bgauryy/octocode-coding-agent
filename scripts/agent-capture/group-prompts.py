#!/usr/bin/env python3
"""group-prompts.py <prompts.jsonl> <outdir> <label>: verbatim category files + INDEX.md (keyword rules, first match wins)."""
import json, os, re, sys

src, outdir, label = sys.argv[1], sys.argv[2], sys.argv[3]
RULES = [
    ("compaction", r"summar(y|ize|ization)|compact|context window|continuation"),
    ("subagents", r"subagent|sub-agent|\bagent type|spawn|teammate|Explore agent|You are an agent|hand-?back|delegat"),
    ("reminders", r"system-reminder|<reminder|reminder"),
    ("permissions-safety", r"permission|classif|auto mode|dangerous|destructive|sandbox|approv|escalat|prompt injection|malicious"),
    ("memory", r"\bmemor(y|ies)\b|MEMORY\.md|CLAUDE\.md|AGENTS\.md"),
    ("planning-tasks", r"plan mode|\bplan\b|todo|task list|goal"),
    ("tools", r"\btool\b|\bUsage\b|parameter|Bash|\bRead\b|\bEdit\b|WebFetch|WebSearch|file_path|command"),
    ("skills-commands", r"\bskill|slash command|/[a-z-]+ "),
    ("git-review", r"\bgit\b|pull request|commit|review|diff"),
    ("system-core", r"You are|IMPORTANT|assistant|the user"),
]
rows = [json.loads(l) for l in open(src)]
cats = {}
for r in rows:
    t = r["text"]
    cat = next((c for c, rx in RULES if re.search(rx, t, re.I)), "other")
    cats.setdefault(cat, []).append(r)
os.makedirs(outdir, exist_ok=True)
index = [f"# {label}: extracted prose strings\n",
         "Prose-like string literals (>= 300 chars, >= 35 words) from the shipped code, grouped by keyword rules (first match wins, so a",
         "category is a lead, not a verdict). `${...}` marks a template value filled at runtime. Anchor = file:offset in the extracted sources.\n",
         "| category | strings | chars | file |", "|---|---:|---:|---|"]
for cat in sorted(cats, key=lambda c: -sum(r["len"] for r in cats[c])):
    items = sorted(cats[cat], key=lambda r: -r["len"])
    fn = f"{cat}.md"
    index.append(f"| {cat} | {len(items)} | {sum(r['len'] for r in items):,} | [{fn}]({fn}) |")
    with open(os.path.join(outdir, fn), "w") as f:
        f.write(f"# {label}: {cat} ({len(items)} strings)\n\nLongest first.\n")
        for k, r in enumerate(items, 1):
            first = re.sub(r"\s+", " ", r["text"][:90]).replace("|", "/")
            f.write(f"\n## {k}. {first}\n\n{r['file']}:{r['offset']} · {r['len']:,} chars\n\n````text\n{r['text']}\n````\n")
index.append(f"\nTotal: {len(rows)} strings, {sum(r['len'] for r in rows):,} chars.\n")
for cat in sorted(cats):
    index.append(f"\n## {cat}: 15 longest\n")
    for r in sorted(cats[cat], key=lambda r: -r["len"])[:15]:
        index.append(f"- {r['len']:,} · `{r['file']}:{r['offset']}` · " + re.sub(r"\s+", " ", r["text"][:110]).replace("`", "'"))
open(os.path.join(outdir, "INDEX.md"), "w").write("\n".join(index) + "\n")
print({c: len(v) for c, v in cats.items()})

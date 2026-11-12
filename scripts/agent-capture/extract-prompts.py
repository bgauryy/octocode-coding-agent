#!/usr/bin/env python3
"""extract-prompts.py <src-dir> <out.jsonl> [min-chars]: prose-like string literals (", ', ` with ${} shown as a
placeholder) from the JavaScript modules in <src-dir>, one JSON line each: {file, offset, len, text}.
Prose: at least min-chars (default 300), at least 35 words, mostly letters and spaces."""
import glob, json, os, re, sys

if len(sys.argv) < 3:
    sys.exit("usage: extract-prompts.py <src-dir> <out.jsonl> [min-chars]")
src = sys.argv[1]
MIN = int(sys.argv[3]) if len(sys.argv) > 3 else 300
out = open(sys.argv[2], "w")
ESC = {"n": "\n", "t": "\t", "r": "", "\\": "\\", '"': '"', "'": "'", "`": "`", "$": "$", "0": ""}
LEAD = re.compile(rb'["\'`]')

def prose(t):
    words = len(re.findall(r"[A-Za-z]{2,}", t))
    if words < 35: return False
    letters = sum(c.isalpha() or c.isspace() for c in t)
    return letters / len(t) > 0.78 and "function(" not in t and "{\n" not in t[:200]

seen = set()
for path in sorted(glob.glob(os.path.join(src, "*.js"))):
    s = open(path, encoding="utf8", errors="replace").read()
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in "\"'`":
            q, j, buf, start = c, i + 1, [], i
            while j < n:
                d = s[j]
                if d == "\\" and j + 1 < n:
                    e = s[j + 1]
                    if e == "u" and s[j + 2:j + 6].isalnum():
                        try: buf.append(chr(int(s[j + 2:j + 6], 16)))
                        except ValueError: pass
                        j += 6; continue
                    buf.append(ESC.get(e, e)); j += 2; continue
                if q == "`" and d == "$" and j + 1 < n and s[j + 1] == "{":
                    depth, k = 1, j + 2
                    while k < n and depth:
                        if s[k] == "{": depth += 1
                        elif s[k] == "}": depth -= 1
                        k += 1
                    expr = s[j + 2:k - 1]
                    buf.append("${" + (expr if len(expr) < 60 else expr[:57] + "...") + "}"); j = k; continue
                if d == q: break
                if q != "`" and d == "\n": break
                buf.append(d); j += 1
            if j - start > MIN:
                t = "".join(buf)
                if len(t) >= MIN and prose(t) and t not in seen:
                    seen.add(t)
                    out.write(json.dumps({"file": os.path.basename(path), "offset": start, "len": len(t), "text": t}) + "\n")
            i = j + 1
        elif c == "/" and i + 1 < n and s[i + 1] == "/":
            k = s.find("\n", i); i = n if k < 0 else k + 1
        else:
            i += 1
out.close()
print(len(seen))

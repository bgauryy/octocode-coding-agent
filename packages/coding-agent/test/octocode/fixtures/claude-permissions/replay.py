import os, json, pathlib, tempfile, subprocess, threading, http.server, hashlib, shlex, argparse, shutil, signal, sys
from harness import configure, run
parser = argparse.ArgumentParser(description='Opt-in Claude permission oracle against a local mock provider; no live provider or inherited auth.')
parser.add_argument('--claude', default=shutil.which('claude'))
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--allow-identity-mismatch', action='store_true')
parser.add_argument('--output', type=pathlib.Path)
args = parser.parse_args()
if not args.claude or not args.node:
    parser.error('Supply --claude and --node executable paths')
CASES = [('original-ask-allow', {'ask': ['Bash']}, False, 'manual', 'ORIGINAL', None, 1), ('original-deny-allow', {'deny': ['Bash']}, False, 'manual', None, None, 0), ('rewrite-new-ask', {'ask': ['Bash(printf REWRITTEN *)']}, True, 'manual', None, None, 1), ('rewrite-new-deny', {'deny': ['Bash(printf REWRITTEN *)']}, True, 'manual', None, None, 1), ('rewrite-no-rule', {}, True, 'manual', None, 'REWRITTEN', 1), ('original-ask-bypass', {'ask': ['Bash']}, False, 'bypassPermissions', 'ORIGINAL', None, 1), ('original-deny-bypass', {'deny': ['Bash']}, False, 'bypassPermissions', None, None, 0), ('original-deny-pattern', {'deny': ['Bash(printf ORIGINAL *)']}, False, 'manual', None, None, 0), ('same-input-rewrite-original-ask', {'ask': ['Bash']}, 'same', 'manual', None, None, 1), ('rewrite-new-ask-bypass', {'ask': ['Bash(printf REWRITTEN *)']}, True, 'bypassPermissions', 'ORIGINAL', None, 0), ('rewrite-both-ask-bypass', {'ask': ['Bash(printf ORIGINAL *)', 'Bash(printf REWRITTEN *)']}, True, 'bypassPermissions', None, None, 1)]

identity = configure(args)
results = []
for (name, rules, rewrite, mode, original, replacement, hook_count) in CASES:
    result = run(name, rules, rewrite, mode)
    expected = {'exit': 0, 'original': original, 'replacement': replacement, 'hook_count': hook_count, 'request_count': 2}
    result['expected'] = expected
    result['passed'] = all((result.get(k) == v for (k, v) in expected.items()))
    results.append(result)
    print(name + ': ' + ('PASS' if result['passed'] else 'FAIL'), file=sys.stderr, flush=True)
report = {'identity': identity, 'scope': 'Isolated local mock-provider behavior, not a live-service test. No permanent user configuration or credentials are loaded.', 'cases': results}
serialized = json.dumps(report, indent=2) + '\n'
if args.output:
    args.output.write_text(serialized)
else:
    print(serialized)
sys.exit(0 if all((r['passed'] for r in results)) else 1)

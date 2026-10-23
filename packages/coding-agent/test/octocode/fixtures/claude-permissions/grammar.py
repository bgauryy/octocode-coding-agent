import argparse, json, pathlib, shutil, sys
from harness import configure, run

parser = argparse.ArgumentParser(description="Opt-in isolated Claude Bash grammar differential oracle.")
parser.add_argument("--claude", default=shutil.which("claude"))
parser.add_argument("--node", default=shutil.which("node"))
parser.add_argument("--allow-identity-mismatch", action="store_true")
parser.add_argument("--output", type=pathlib.Path)
parser.add_argument("--cases", type=pathlib.Path, default=pathlib.Path(__file__).with_name("grammar-cases.json"))
args = parser.parse_args()
if not args.claude or not args.node:
    parser.error("Supply --claude and --node executable paths")
identity = configure(args)
CASES = json.loads(args.cases.read_text())
results = []
for case in CASES:
    name = case['name']
    result = run(name, case['rules'], False, case['mode'], case['command'], files=case.get('files'), symlinks=case.get('symlinks'), observe_files=case.get('observe_files'))
    result['command_template'] = case['command']
    result['expected'] = case['expected']
    outputs = result['tool_results']
    result['passed'] = (
        all(result.get(k) == v for k, v in case['expected'].items())
        and bool(outputs)
        and all(output['is_error'] == case['tool_error'] for output in outputs)
        and (case['result_contains'] is None or any(case['result_contains'] in output['content'] for output in outputs))
    )
    results.append(result)
    print(name + ': ' + ('PASS' if result['passed'] else 'FAIL'), file=sys.stderr, flush=True)
report = {"identity": identity, "scope": "Isolated local provider, dummy credentials, executable hash guard. Shell effects are confined to owned temporary directories.", "cases": results}
serialized = json.dumps(report, indent=2) + "\n"
if args.output:
    args.output.write_text(serialized)
else:
    print(serialized)
sys.exit(0 if all(result["passed"] for result in results) else 1)

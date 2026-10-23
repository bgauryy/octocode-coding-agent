import argparse,json,pathlib,shutil,sys
from harness import configure,run
parser=argparse.ArgumentParser(description='Opt-in isolated Claude permission replacement oracle.')
parser.add_argument('--claude',default=shutil.which('claude'));parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--allow-identity-mismatch',action='store_true');parser.add_argument('--output',type=pathlib.Path)
args=parser.parse_args()
if not args.claude or not args.node:parser.error('Supply --claude and --node')
identity=configure(args);results=[]
for case in json.loads(pathlib.Path(__file__).with_name('rewrite-cases.json').read_text()):
 r=run(case['name'],case['rules'],case['rewrite'],case['mode'],hook_output=case.get('hook_output'),second_output=case.get('second_output'),permission_host=case.get('permission_host',False))
 r['expected']=case['expected'];r['passed']=all(r.get(k)==v for k,v in case['expected'].items()) and bool(r['tool_results']) and all(x['is_error']==case['tool_error'] for x in r['tool_results']) and ('expected_host_count' not in case or len(r['host_inputs'])==case['expected_host_count'])
 results.append(r);print(case['name']+': '+('PASS' if r['passed'] else 'FAIL'),file=sys.stderr,flush=True)
report={'identity':identity,'scope':'Local provider and actual command hooks; optional actual MCP permission host. Delayed second-handler observations are bounded races, not universal scheduling guarantees. Interactive replacement re-prompt remains unverified.','cases':results}
text=json.dumps(report,indent=2)+'\n'
if args.output:args.output.write_text(text)
else:print(text)
sys.exit(0 if all(r['passed'] for r in results) else 1)

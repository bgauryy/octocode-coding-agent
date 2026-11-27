import argparse,json,pathlib,shutil,sys
from harness import configure,run
p=argparse.ArgumentParser(description='Opt-in isolated Claude replace_all edit oracle.')
p.add_argument('--claude',default=shutil.which('claude'));p.add_argument('--node',default=shutil.which('node'));p.add_argument('--allow-identity-mismatch',action='store_true');p.add_argument('--output',type=pathlib.Path)
a=p.parse_args()
if not a.claude or not a.node:p.error('Supply --claude and --node')
identity=configure(a);results=[]
cases=[
 ('partial-read-seen-unseen','BEFORE\nother\nBEFORE\n','BEFORE','AFTER',{'offset':1,'limit':1},None,'AFTER\nother\nAFTER\n',1,False),
 ('exact-plus-curly-quote','"hello"\n“hello”\n','"hello"','AFTER',{},None,'AFTER\n“hello”\n',1,False),
 ('trailing-space-fallback','hello   \nhello   \n','hello\n','AFTER\n',{},None,'hello   \nhello   \n',0,True),
 ('overlapping-anchor','aaa','aa','X',{},None,'Xa',1,False),
 ('replacement-contains-anchor','aa aa','aa','aaaa',{},None,'aaaa aaaa',1,False),
 ('stale-after-read','BEFORE BEFORE','BEFORE','AFTER',{},'EXTERNAL BEFORE BEFORE','EXTERNAL AFTER AFTER',1,False),
 ('stale-extra-occurrence','BEFORE|BEFORE','BEFORE','AFTER',{},'PREFIX BEFORE|BEFORE;BEFORE','PREFIX AFTER|AFTER;AFTER',1,False),
 ('curly-quote-only','“hello”\n“hello”\n','"hello"','AFTER',{},None,'AFTER\nAFTER\n',1,False),
 ('crlf-normalized','BEFORE\r\nBEFORE\r\n','BEFORE\n','AFTER\n',{},None,'AFTER\r\nAFTER\r\n',1,False),
]
for name,body,anchor,new,readrange,stale,expected,hooks,error in cases:
 candidate={'file_path':'$ORIGINAL_PATH','old_string':anchor,'new_string':new,'replace_all':True}
 r=run(name,{},True,'manual',files={'original.txt':body},tool_name='Edit',tool_input={**candidate,'new_string':'ORIGINAL'},read_first=True,read_range=readrange,after_read=stale,hook_output={'hookSpecificOutput':{'hookEventName':'PermissionRequest','decision':{'behavior':'allow','updatedInput':candidate}}})
 r['expected']={'original':expected,'hook_count':hooks,'last_tool_error':error}
 r['passed']=r['exit']==0 and r['original']==expected and r['hook_count']==hooks and bool(r['tool_results']) and r['tool_results'][-1]['is_error']==error
 results.append(r);print(name+': '+('PASS' if r['passed'] else 'FAIL'),file=sys.stderr,flush=True)
for name,body,anchor in [('candidate-trailing-space','hello   \nhello   \n','hello\n'),('candidate-width-fold','ＢＥＦＯＲＥ ＢＥＦＯＲＥ','BEFORE')]:
 r=run(name,{},True,'manual',files={'original.txt':body},tool_name='Edit',tool_input={'file_path':'$ORIGINAL_PATH','old_string':body,'new_string':'ORIGINAL'},read_first=True,hook_output={'hookSpecificOutput':{'hookEventName':'PermissionRequest','decision':{'behavior':'allow','updatedInput':{'file_path':'$ORIGINAL_PATH','old_string':anchor,'new_string':'AFTER','replace_all':True}}}})
 r['expected']={'original':body,'hook_count':1,'last_tool_error':True}
 r['passed']=r['exit']==0 and r['original']==body and r['hook_count']==1 and bool(r['tool_results']) and r['tool_results'][-1]['is_error']
 results.append(r);print(name+': '+('PASS' if r['passed'] else 'FAIL'),file=sys.stderr,flush=True)
report={'identity':identity,'scope':'Actual Read then source Edit plus PermissionRequest replacement; original bytes decoded without universal newline conversion.','cases':results};text=json.dumps(report,indent=2)+'\n'
if a.output:a.output.write_text(text)
else:print(text)
sys.exit(0 if all(r['passed'] for r in results) else 1)

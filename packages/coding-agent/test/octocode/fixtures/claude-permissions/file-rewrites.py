import argparse,json,pathlib,shutil,sys
from harness import configure,run
p=argparse.ArgumentParser(description='Opt-in isolated Claude Write/Edit replacement oracle.')
p.add_argument('--claude',default=shutil.which('claude'));p.add_argument('--node',default=shutil.which('node'));p.add_argument('--allow-identity-mismatch',action='store_true');p.add_argument('--output',type=pathlib.Path)
a=p.parse_args()
if not a.claude or not a.node:p.error('Supply --claude and --node')
identity=configure(a);results=[]
cases=[
 ('write-new-path','Write',False,{},None,{'file_path':'$REPLACEMENT_PATH','content':'REWRITTEN'},None,'REWRITTEN',1,False),
 ('write-empty','Write',False,{},None,{},'ORIGINAL',None,1,False),
 ('write-candidate-deny','Write',False,{'deny':['Edit(./replacement.txt)']},None,{'file_path':'$REPLACEMENT_PATH','content':'REWRITTEN'},None,None,1,True),
 ('write-candidate-ask','Write',False,{'ask':['Edit(./replacement.txt)']},None,{'file_path':'$REPLACEMENT_PATH','content':'REWRITTEN'},None,None,1,True),
 ('write-unread','Write',False,{},'BEFORE',{'file_path':'$REPLACEMENT_PATH','content':'REWRITTEN'},'BEFORE',None,0,True),
 ('edit-unread','Edit',False,{},'BEFORE',{'file_path':'$ORIGINAL_PATH','old_string':'BEFORE','new_string':'REWRITTEN'},'BEFORE',None,0,True),
 ('edit-read','Edit',True,{},'BEFORE',{'file_path':'$ORIGINAL_PATH','old_string':'BEFORE','new_string':'REWRITTEN'},'REWRITTEN',None,1,False),
 ('edit-candidate-unread','Edit',True,{},'BEFORE',{'file_path':'$REPLACEMENT_PATH','old_string':'BEFORE','new_string':'REWRITTEN'},'BEFORE','BEFORE',1,True),
 ('edit-all-true','Edit',True,{},'BEFORE BEFORE',{'file_path':'$ORIGINAL_PATH','old_string':'BEFORE','new_string':'AFTER','replace_all':True},'AFTER AFTER',None,1,False),
 ('edit-all-false','Edit',True,{},'BEFORE BEFORE',{'file_path':'$ORIGINAL_PATH','old_string':'BEFORE','new_string':'AFTER','replace_all':False},'BEFORE BEFORE',None,1,True),
 ('edit-unknown-field','Edit',True,{},'BEFORE',{'file_path':'$ORIGINAL_PATH','old_string':'BEFORE','new_string':'AFTER','arbitrary':'IGNORED'},'AFTER',None,1,False),
 ('write-unknown-field','Write',False,{},None,{'file_path':'$REPLACEMENT_PATH','content':'AFTER','arbitrary':'IGNORED'},None,'AFTER',1,False),
]
for name,tool,readfirst,rules,original,replacement,expected_original,expected_replacement,hooks,error in cases:
 files={} if original is None else {'original.txt':original}
 if name=='edit-candidate-unread':files['replacement.txt']='BEFORE'
 tool_input={'file_path':'$ORIGINAL_PATH',**({'content':'ORIGINAL'} if tool=='Write' else {'old_string':original,'new_string':'ORIGINAL'})}
 r=run(name,rules,True,'manual',files=files,hook_output={'hookSpecificOutput':{'hookEventName':'PermissionRequest','decision':{'behavior':'allow','updatedInput':replacement}}},tool_name=tool,tool_input=tool_input,read_first=readfirst)
 r['expected']={'original':expected_original,'replacement':expected_replacement,'hook_count':hooks,'last_tool_error':error}
 r['passed']=r['exit']==0 and r['original']==expected_original and r['replacement']==expected_replacement and r['hook_count']==hooks and bool(r['tool_results']) and r['tool_results'][-1]['is_error']==error
 results.append(r);print(name+': '+('PASS' if r['passed'] else 'FAIL'),file=sys.stderr,flush=True)
for name,body,anchor in [('original-missing-anchor','BEFORE','MISSING'),('original-ambiguous-anchor','BEFORE BEFORE','BEFORE')]:
 r=run(name,{},True,'manual',files={'original.txt':body},tool_name='Edit',tool_input={'file_path':'$ORIGINAL_PATH','old_string':anchor,'new_string':'ORIGINAL'},read_first=True,hook_output={'hookSpecificOutput':{'hookEventName':'PermissionRequest','decision':{'behavior':'allow','updatedInput':{'file_path':'$ORIGINAL_PATH','old_string':body,'new_string':'REWRITTEN'}}}})
 r['expected']={'original':body,'replacement':None,'hook_count':0,'last_tool_error':True}
 r['passed']=r['exit']==0 and r['original']==body and r['replacement'] is None and r['hook_count']==0 and bool(r['tool_results']) and r['tool_results'][-1]['is_error']
 results.append(r);print(name+': '+('PASS' if r['passed'] else 'FAIL'),file=sys.stderr,flush=True)
report={'identity':identity,'scope':'Single Write/Edit source calls; real prior Read where indicated. No native batch transaction claim.','cases':results}
text=json.dumps(report,indent=2)+'\n'
if a.output:a.output.write_text(text)
else:print(text)
sys.exit(0 if all(r['passed'] for r in results) else 1)

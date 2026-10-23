import argparse,json,pathlib,shutil,sys
from harness import configure,run
p=argparse.ArgumentParser(description="Opt-in isolated Claude permission update ordering and persistence oracle.")
p.add_argument('--claude',default=shutil.which('claude'));p.add_argument('--node',default=shutil.which('node'));p.add_argument('--allow-identity-mismatch',action='store_true');p.add_argument('--output',type=pathlib.Path)
a=p.parse_args()
if not a.claude or not a.node:p.error('Supply --claude and --node')
identity=configure(a)
def allow(**kw):return {'hookSpecificOutput':{'hookEventName':'PermissionRequest','decision':{'behavior':'allow',**kw}}}
def update(kind,pattern,behavior='allow',destination='session'):
 d={'type':kind,'rules':[{'toolName':'Bash','ruleContent':pattern}],'behavior':behavior}
 if destination is not None:d['destination']=destination
 return d
def tool(cmd):return {'name':'Bash','input':{'command':cmd}}
f='node -p 41';s='node -p 42';t='node -p 43';four='node -p 44'
cases=[]
def add(name,seq,outputs,errors,hooks,**kw):cases.append((name,dict(tool_sequence=seq,hook_outputs=outputs,**kw),errors,hooks))
sequence=[tool(f),tool(f),tool(s),tool(t)]
add('control',sequence,[allow()],[False,True,True,True],4)
add('session-next-allow',sequence,[allow(updatedPermissions=[update('addRules',s)])],[False,True,False,True],3)
add('deny-current-versus-next',sequence,[allow(updatedPermissions=[update('addRules',f,'deny')])],[False,True,True,True],3)
add('invalid-rewrite-no-retention',sequence,[allow(updatedInput={'command':123},updatedPermissions=[update('addRules',s)])],[True,True,True,True],4)
add('denied-rewrite-no-retention',sequence,[allow(updatedInput={'command':'printf REPLACED > replacement.txt'},updatedPermissions=[update('addRules',s)])],[True,True,True,True],4,rules={'deny':['Bash(printf REPLACED*)']})
add('ask-current-versus-next',sequence,[allow(updatedPermissions=[update('addRules',f,'ask')])],[False,True,True,True],4)
add('add-then-remove',[tool(f),tool(t),tool(s)],[allow(updatedPermissions=[update('addRules',s)]),allow(updatedPermissions=[update('removeRules',s)])],[False,False,True],3)
add('replace-removes-prior',[tool(f),tool(t),tool(s),tool(four)],[allow(updatedPermissions=[update('addRules',s)]),allow(updatedPermissions=[update('replaceRules',four)])],[False,False,True,False],3)
add('same-list-add-remove',[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s),update('removeRules',s)])],[False,True],2)
add('same-list-remove-add',[tool(f),tool(s)],[allow(updatedPermissions=[update('removeRules',s),update('addRules',s)])],[False,False],1)
add('missing-destination',[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s,destination=None)])],[True,True],2)
add('unknown-destination',[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s,destination='unknown')])],[True,True],2)
add('malformed-later-entry',[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s),{'type':'unknown','destination':'session'}])],[True,True],2)
add('allow-and-deny-same-list',[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s),update('addRules',s,'deny')])],[False,True],1)
for dest,sources,hooks,errors in [('session','user',3,[True,True]),('userSettings','user',2,[False,True]),('projectSettings','user',4,[True,True]),('localSettings','user',4,[True,True]),('projectSettings','user,project,local',4,[True,True]),('localSettings','user,project,local',2,[False,True])]:
 add('restart-'+dest+'-'+sources,[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s,destination=dest)])],errors,hooks,restart_sequence=[tool(s),tool(t)],setting_sources=sources)
for mode,hooks in [('dontAsk',1),('bypassPermissions',2)]:
 add('mode-'+mode,[tool(f),tool(s)],[allow(updatedPermissions=[{'type':'setMode','mode':mode,'destination':'session'}])],[False,True],hooks)
add('mode-accept-edits',[tool(f),{'name':'Write','input':{'file_path':'$ORIGINAL_PATH','content':'MODE_WRITE'}}],[allow(updatedPermissions=[{'type':'setMode','mode':'acceptEdits','destination':'session'}])],[False,False],1)
for label,kinds,errors,hooks in [('control',[],[False,True],2),('add',['addDirectories'],[False,False],1),('add-remove',['addDirectories','removeDirectories'],[False,True],2),('remove-add',['removeDirectories','addDirectories'],[False,False],1)]:
 updates=[{'type':'setMode','mode':'acceptEdits','destination':'session'},*[{'type':kind,'directories':['$CASE_ROOT'],'destination':'session'} for kind in kinds]]
 add('directories-'+label,[tool(f),{'name':'Write','input':{'file_path':'$CASE_ROOT/outside.txt','content':'OUTSIDE'}}],[allow(updatedPermissions=updates)],errors,hooks,observe_files=['../outside.txt'])
add('restart-project-trusted',[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s,destination='projectSettings')])],[False,True],2,restart_sequence=[tool(s),tool(t)],setting_sources='user,project,local',trust_project=True)
for destination in ['userSettings','localSettings','projectSettings']:
 for configured in [False,True]:
  add('persist-mode-'+destination+'-'+str(configured),[tool(f)],[allow(updatedPermissions=[{'type':'setMode','mode':'acceptEdits','destination':destination}])],[not configured],1 if configured else 2,restart_sequence=[{'name':'Write','input':{'file_path':'$ORIGINAL_PATH','content':'PERSISTED_MODE'}}],setting_sources='user,project,local',restart_configured_mode=configured)
for destination in ['session','userSettings']:
 for failed_first in [False,True]:
  good=update('addRules',s,destination=destination);bad=update('addRules',t,destination='projectSettings')
  add('write-failure-'+destination+'-'+str(failed_first),[tool(f),tool(s),tool(t)],[allow(updatedPermissions=[bad,good] if failed_first else [good,bad])],[False,False,destination=='userSettings'],2 if destination=='userSettings' else 1,obstruct_settings=['.claude/settings.json'],setting_sources='user,project,local')
for name,destinations,obstruct,errors,hooks in [('failed-project-only',['projectSettings'],True,[False,False,True],2),('healthy-session-project',['session','projectSettings'],False,[False,False,True],2),('healthy-session-user',['session','userSettings'],False,[False,False,False],1),('failed-session-project',['session','projectSettings'],True,[False,False,False],1)]:
 updates=[update('addRules',s if i==0 else t,destination=destination) for i,destination in enumerate(destinations)]
 add(name,[tool(f),tool(s),tool(t)],[allow(updatedPermissions=updates)],errors,hooks,obstruct_settings=['.claude/settings.json'] if obstruct else None,setting_sources='user,project,local')
add('execution-failure-retains-update',[tool("node -e 'process.exit(7)'"),tool(s)],[allow(updatedPermissions=[update('addRules',s)])],[True,False],1)
for destination in ['projectSettings','localSettings']:
 for failed_first in [False,True]:
  failed=update('addRules',s,destination='userSettings');good=update('addRules',t,destination=destination)
  add('failed-user-'+destination+'-'+str(failed_first),[tool(f),tool(s),tool(t)],[allow(updatedPermissions=[failed,good] if failed_first else [good,failed])],[False,True,destination=='projectSettings'],3 if destination=='projectSettings' else 2,obstruct_settings=['../config/settings.json'],obstruct_in_hook=True,setting_sources='user,project,local')
add('readonly-project-persistence',[tool(f),tool(s)],[allow(updatedPermissions=[update('addRules',s,destination='projectSettings')])],[False,False],1,files={'.claude/settings.json':'{}'},readonly_settings=['.claude/settings.json'],setting_sources='user,project,local',trust_project=True)
results=[]
for name,options,errors,hooks in cases:
 rules=options.pop('rules',{})
 r=run(name,rules,**options)
 r['expected']={'tool_errors':errors,'hook_count':hooks}
 r['passed']=r['exit']==0 and r['hook_count']==hooks and [v['is_error'] for v in r['tool_result_sequence']]==errors and all(v['exit']==0 for v in r.get('launches',[]))
 if name=='mode-accept-edits':r['passed']=r['passed'] and r['original']=='MODE_WRITE'
 if name.startswith('directories-'):r['passed']=r['passed'] and r['files']['../outside.txt']==('OUTSIDE' if not errors[-1] else None)
 if options.get('obstruct_settings'):r['passed']=r['passed'] and r['obstructed_paths_after']=={relative:'directory' for relative in options['obstruct_settings']} and any('EISDIR' in line for line in r['settings_diagnostics'])
 if options.get('readonly_settings'):r['passed']=r['passed'] and r['readonly_paths_after']=={'.claude/settings.json':'{}'} and any('EACCES' in line for line in r['settings_diagnostics'])
 if name.startswith('persist-mode-'):r['passed']=r['passed'] and any(config.get('permissions',{}).get('defaultMode')=='acceptEdits' for config in r['config_files_after'].values()) and r['original']==('PERSISTED_MODE' if options.get('restart_configured_mode') else None)
 results.append(r);print(name+': '+('PASS' if r['passed'] else 'FAIL'),file=sys.stderr,flush=True)
 report={'identity':identity,'scope':'Sequential unique tool IDs in actual CLI; final request contains one result per invocation. Restart cases start a new CLI process in same owned home. Project allows remain untrusted in this fixture; bypass mode unavailable.','cases':results}
 if a.output:a.output.write_text(json.dumps(report,indent=2)+'\n')
if not a.output:print(json.dumps(report,indent=2))
sys.exit(0 if all(r['passed'] for r in results) else 1)

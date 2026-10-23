import os, json, pathlib, tempfile, subprocess, threading, http.server, hashlib, shlex, argparse, shutil, signal, sys
EXPECTED_VERSION = '2.1.309 (Claude Code)'
EXPECTED_SHA256 = '5eadc0009cdcdbc0d06e58110d7b2baf88ced6088b1c33a60a21217fe410619c'

class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        body = json.loads(raw or '{}')
        self.server.records.append({'path': self.path, 'body': body})
        if 'count_tokens' in self.path:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"input_tokens":1}')
            return
        self.server.calls += 1
        if self.server.calls == 1 and self.server.obstruct_settings is not None:
            self.server.obstruct_settings()
        if self.server.calls == 2 and self.server.after_read is not None:
            pathlib.Path(self.server.tool_input["file_path"]).write_text(self.server.after_read)
        tool = self.server.calls <= (2 if self.server.read_first else 1)
        current_tool = "Read" if self.server.read_first and self.server.calls == 1 else self.server.tool_name
        current_input = {"file_path": self.server.tool_input["file_path"], **self.server.read_range} if current_tool == "Read" else self.server.tool_input
        if self.server.tool_sequence is not None:
            tool = self.server.calls <= len(self.server.tool_sequence)
            selected = self.server.tool_sequence[self.server.calls - 1] if tool else {}
            current_tool = selected.get('name', 'Bash')
            current_input = selected.get('input', {})
        block = {'type': 'tool_use', 'id': 'toolu_fixture_' + str(self.server.calls), 'name': current_tool, 'input': {}} if tool else {'type': 'text', 'text': ''}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        events = [('message_start', {'type': 'message_start', 'message': {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-4-5-20250929', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}}), ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': block}), ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(current_input)} if tool else {'type': 'text_delta', 'text': 'VENDOR_COMPLETE'}}), ('content_block_stop', {'type': 'content_block_stop', 'index': 0}), ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if tool else 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}), ('message_stop', {'type': 'message_stop'})]
        for (event, data) in events:
            self.wfile.write(('event: ' + event + '\ndata: ' + json.dumps(data) + '\n\n').encode())
        self.wfile.flush()

def run(name, rules, rewrite=False, mode='manual', command_template=None, files=None, symlinks=None, observe_files=None, hook_output=None, second_output=None, second_delay_ms=100, permission_host=False, tool_name="Bash", tool_input=None, read_first=False, read_range=None, after_read=None, tool_sequence=None, hook_outputs=None, restart_sequence=None, setting_sources='user', restart_configured_mode=False, obstruct_settings=None, trust_project=False, obstruct_in_hook=False, readonly_settings=None, readonly_files=False):
    with tempfile.TemporaryDirectory(prefix='claude-permission-vendor-') as d:
        root = pathlib.Path(d)
        home = root / 'home'
        home.mkdir()
        cfg = root / 'config'
        cfg.mkdir()
        cwd = root / 'project'
        cwd.mkdir()
        if trust_project:
            trust = {'projects': {str(cwd): {'hasTrustDialogAccepted': True}, str(cwd.resolve()): {'hasTrustDialogAccepted': True}}}
            for config_home in [home, cfg]:
                (config_home / '.claude.json').write_text(json.dumps(trust))
        def owned_file(relative):
            candidate = cwd / relative
            if not candidate.resolve().is_relative_to(root.resolve()):
                raise ValueError('Fixture file must remain in the owned temporary root')
            return candidate
        for relative, content in (files or {}).items():
            target = owned_file(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        for relative, destination in (symlinks or {}).items():
            target = owned_file(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(owned_file(destination))
        marker = cwd / 'original.txt' 
        replacement = cwd / 'replacement.txt'
        capture = root / 'hooks.jsonl'
        command = 'printf ORIGINAL > ' + shlex.quote(str(marker))
        if command_template is not None:
            command = command_template.replace('$MARKER', shlex.quote(str(marker)))
        changed = 'printf REWRITTEN > ' + shlex.quote(str(replacement))
        hook = root / 'hook.cjs'
        out = {'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': {'behavior': 'allow', **({'updatedInput': {'command': command if rewrite == 'same' else changed, 'description': 'Rewritten safe fixture'}} if rewrite else {})}}}
        def expand_output(value):
            if isinstance(value, dict):
                return {key: expand_output(item) for key, item in value.items()}
            if isinstance(value, list):
                return [expand_output(item) for item in value]
            if isinstance(value, str):
                return value.replace('$CASE_ROOT', str(root)).replace('$ORIGINAL_PATH', str(marker)).replace('$REPLACEMENT_PATH', str(replacement)).replace('$ORIGINAL_COMMAND', command).replace('$REPLACEMENT_COMMAND', changed).replace('$OTHER_COMMAND', 'printf OTHER > ' + shlex.quote(str(replacement)))
            return value
        if hook_output is not None:
            out = expand_output(hook_output)
        hook.write_text("const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.appendFileSync(" + json.dumps(str(capture)) + ",s+'\\n');console.log(" + json.dumps(json.dumps(out)) + ');});')
        if hook_outputs is not None:
            outputs = expand_output(hook_outputs)
            hook.write_text("const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const p=" + json.dumps(str(capture)) + ";const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\\n').filter(Boolean).length:0;fs.appendFileSync(p,s+'\\n');const outputs=" + json.dumps(outputs) + ";console.log(JSON.stringify(outputs[n]??{}));});")
        settings = {'permissions': json.loads(json.dumps(rules).replace('$CASE_ROOT', str(root))), 'hooks': {'PermissionRequest': [{'hooks': [{'type': 'command', 'command': shlex.quote(NODE) + ' ' + shlex.quote(str(hook))}]}]}}
        second_events = root / 'second-events.txt'
        if second_output is not None:
            second = root / 'second.cjs'
            second.write_text("const fs=require('node:fs');const p=" + json.dumps(str(second_events)) + ";fs.appendFileSync(p,'started\\n');setTimeout(()=>{fs.appendFileSync(p,'completed\\n');console.log(" + json.dumps(json.dumps(expand_output(second_output))) + ");}," + str(second_delay_ms) + ");")
            settings['hooks']['PermissionRequest'][0]['hooks'].append({'type': 'command', 'command': shlex.quote(NODE) + ' ' + shlex.quote(str(second))})
        settingsFile = cfg / 'settings.json'
        settingsFile.write_text(json.dumps(settings))
        if obstruct_in_hook:
            targets = [str(owned_file(relative)) for relative in (obstruct_settings or [])]
            mutation = 'for(const p of '+json.dumps(targets)+'){if(!fs.existsSync(p)||!fs.statSync(p).isDirectory()){fs.rmSync(p,{force:true});fs.mkdirSync(p,{recursive:true});}}'
            hook.write_text(hook.read_text().replace('console.log(', mutation+'console.log(', 1))
        readonly_modes = [(owned_file(relative).parent, owned_file(relative).parent.stat().st_mode & 0o777) for relative in readonly_settings or []]
        readonly_file_modes = [(owned_file(relative), owned_file(relative).stat().st_mode & 0o777) for relative in readonly_settings or []] if readonly_files else []
        if readonly_settings:
            targets = [str(directory) for directory, _ in readonly_modes]
            mutation = 'for(const p of '+json.dumps(targets)+'){fs.chmodSync(p,0o555);}' + 'for(const p of '+json.dumps([str(file) for file, _ in readonly_file_modes])+'){fs.chmodSync(p,0o444);}'
            hook.write_text(hook.read_text().replace('console.log(', mutation+'console.log(', 1))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        def obstruct():
            for relative in obstruct_settings or []:
                candidate = owned_file(relative)
                candidate.parent.mkdir(parents=True, exist_ok=True)
                if candidate.is_file():candidate.unlink()
                candidate.mkdir(exist_ok=True)
        server.obstruct_settings = obstruct if obstruct_settings and not obstruct_in_hook else None
        server.records = []
        server.calls = 0
        server.command = command
        server.tool_name = tool_name
        server.tool_input = expand_output(tool_input) if tool_input is not None else {"command": command, "description": "Safe fixture marker"}
        server.tool_sequence = expand_output(tool_sequence) if tool_sequence is not None else None
        server.read_first = read_first
        server.read_range = read_range or {}
        server.after_read = after_read
        t = threading.Thread(target=server.serve_forever)
        t.start()
        env = {'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(cfg), 'PATH': str(pathlib.Path(NODE).parent) + ':/usr/bin:/bin', 'SHELL': '/bin/bash', 'TMPDIR': d, 'ANTHROPIC_API_KEY': 'sk-ant-local-fixture-not-real', 'ANTHROPIC_BASE_URL': 'http://127.0.0.1:' + str(server.server_port), 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1', 'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1', 'DISABLE_FEEDBACK_COMMAND': '1', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1', 'CLAUDE_CODE_MAX_RETRIES': '0', 'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': '127.0.0.1,localhost'}
        args = [CLI, '-p', 'Execute the safe fixture command.', '--model', 'claude-sonnet-4-5-20250929', '--system-prompt', 'Use the supplied tools, then finish.', '--output-format', 'json', '--tools', 'Bash' if tool_name == 'Bash' else 'Write,Edit,Read', '--permission-mode', mode, '--settings', str(settingsFile), '--setting-sources', setting_sources, '--strict-mcp-config', '--no-chrome', '--disable-slash-commands', '--no-session-persistence', '--debug-file', str(root / 'debug.log')]
        if tool_sequence is not None:
            args[args.index('--tools') + 1] = ','.join(sorted({item['name'] for item in [*tool_sequence, *(restart_sequence or [])]}))
        host_capture = root / 'host.jsonl'
        if permission_host:
            host = root / 'host.cjs'
            host.write_text("const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',l=>{let q=JSON.parse(l);if(q.id===undefined)return;const send=r=>console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:r}));if(q.method==='initialize')send({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});else if(q.method==='tools/list')send({tools:[{name:'approve',description:'Approve owned fixture',inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object'},tool_use_id:{type:'string'}},additionalProperties:true}}]});else if(q.method==='tools/call'){const a=q.params.arguments;fs.appendFileSync(" + json.dumps(str(host_capture)) + ",JSON.stringify(a)+'\\n');setTimeout(()=>send({content:[{type:'text',text:JSON.stringify({behavior:'allow',updatedInput:a.input})}]}),750);}else send({});});")
            mcp = root / 'mcp.json'
            mcp.write_text(json.dumps({'mcpServers': {'approval': {'command': NODE, 'args': [str(host)]}}}))
            args.extend(['--mcp-config', str(mcp), '--permission-prompt-tool', 'mcp__approval__approve'])
        try:
            launches = []
            for launch in range(2 if restart_sequence is not None else 1):
                if launch:
                    server.tool_sequence = expand_output(restart_sequence)
                    server.calls = 0
                launch_args = list(args)
                if launch and restart_configured_mode:
                    mode_index = launch_args.index('--permission-mode')
                    del launch_args[mode_index:mode_index + 2]
                process = subprocess.Popen(launch_args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    (stdout, stderr) = process.communicate(timeout=30)
                    code = process.returncode
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    (stdout, stderr) = process.communicate()
                    code = 'timeout'
                finally:
                    if process.poll() is None:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                launches.append({'exit': code, 'request_count': server.calls})
            records = [json.loads(x) for x in capture.read_text().splitlines() if x.strip()] if capture.exists() else []
            result = {'case': name, 'exit': code, 'original': marker.read_bytes().decode("utf-8") if marker.exists() else None, 'replacement': replacement.read_text() if replacement.exists() else None, 'hook_count': len(records), 'request_count': server.calls, 'rule_config': rules, 'mode': mode, 'replacement_supplied': bool(rewrite), 'hook_inputs': [{'event': r.get('hook_event_name'), 'tool': r.get('tool_name'), 'command': r.get('tool_input', {}).get('command', '').replace(d, '$CASE_ROOT'), 'input': json.loads(json.dumps(r.get('tool_input', {})).replace(d, '$CASE_ROOT'))} for r in records], 'request_paths': [r['path'] for r in server.records]}
            if readonly_settings:
                result["readonly_paths_after"] = {relative: owned_file(relative).read_text() for relative in readonly_settings}
            if obstruct_settings or readonly_settings:
                result['obstructed_paths_after'] = {relative: ('directory' if owned_file(relative).is_dir() else 'file' if owned_file(relative).is_file() else 'missing') for relative in (obstruct_settings or [])}
                debug = root / 'debug.log'
                result['settings_diagnostics'] = [line.replace(d, '$CASE_ROOT') for line in debug.read_text(errors='replace').splitlines() if 'settings.json' in line and any(word in line.lower() for word in ['error', 'eisdir', 'eacces', 'failed', 'directory'])][-20:] if debug.exists() else []
            if restart_sequence is not None:
                result['launches'] = launches
            if tool_sequence is not None:
                result['settings_after'] = json.loads(settingsFile.read_text().replace(d, '$CASE_ROOT')) if settingsFile.is_file() else None
                result['config_files_after'] = {str(p.relative_to(root)): json.loads(p.read_text().replace(d, '$CASE_ROOT')) for p in root.rglob('settings*.json') if p.is_file()}
            if permission_host:
                result['host_inputs'] = [json.loads(line.replace(d, '$CASE_ROOT')) for line in host_capture.read_text().splitlines()] if host_capture.exists() else []
            if second_output is not None:
                result['second_events'] = second_events.read_text() if second_events.exists() else ''
            result['files'] = {relative: owned_file(relative).read_text() if owned_file(relative).exists() else None for relative in (observe_files or [])}
            result['tool_results'] = [
                {'is_error': block.get('is_error', False), 'content': json.dumps(block.get('content')).replace(d, '$CASE_ROOT')}
                for request in server.records
                for message in request['body'].get('messages', [])
                for block in (message.get('content', []) if isinstance(message.get('content'), list) else [])
                if isinstance(block, dict) and block.get('type') == 'tool_result'
            ]
            if tool_sequence is not None:
                final_requests = [r for r in server.records if 'count_tokens' not in r['path']]
                result['tool_result_sequence'] = [
                    {'tool_use_id': block.get('tool_use_id'), 'is_error': block.get('is_error', False), 'content': json.dumps(block.get('content')).replace(d, '$CASE_ROOT')}
                    for message in final_requests[-1]['body'].get('messages', [])
                    for block in (message.get('content', []) if isinstance(message.get('content'), list) else [])
                    if isinstance(block, dict) and block.get('type') == 'tool_result'
                ] if final_requests else []
            if code != 0:
                result['error'] = stderr.replace(d, '$CASE_ROOT')[-2000:]
            return result
        finally:
            for directory, mode in [*readonly_modes, *readonly_file_modes]:
                directory.chmod(mode)
            server.shutdown()
            server.server_close()
            t.join()

def configure(args):
    global CLI, NODE
    CLI = os.path.abspath(args.claude)
    NODE = os.path.abspath(args.node)
    with tempfile.TemporaryDirectory(prefix='claude-oracle-identity-') as home:
        identity = {'executable': CLI, 'realpath': os.path.realpath(CLI), 'sha256': hashlib.sha256(pathlib.Path(CLI).read_bytes()).hexdigest(), 'version': subprocess.check_output([CLI, '--version'], env={'HOME': home, 'CLAUDE_CONFIG_DIR': home, 'PATH': '/usr/bin:/bin'}, text=True, timeout=10).strip()}
    if not args.allow_identity_mismatch and (identity['version'] != EXPECTED_VERSION or identity['sha256'] != EXPECTED_SHA256):
        raise RuntimeError('Installed executable identity differs from recorded oracle. Pass --allow-identity-mismatch only for an intentional new-version comparison.')
    return identity

"""Exit audit: does a closing Octocode process leave nothing it started behind?

Starts the TUI in a private tmux server against a local scripted model (no network, no cost), makes it acquire what it
can (a background bash job, a background subagent holding a command, octocode-mcp search and LSP, and optionally the
`/web` daemon or the shell sandbox), ends it one way and lists every process, socket, lock and temp folder left.

  python3 scripts/exit-audit.py [--mode bundle|source] [--web] [--sandbox] [--out DIR] [variant ...]

variants: quit ctrlc pane killserver sigterm sigkill crash (default: all). `bundle` needs `yarn run build:offline`.
--web types `/web item B1` once the session is idle (SSH_CONNECTION is set, so the page address is printed and no
browser opens) and requires the daemon to exit within its idle time (6 s here) after the session ends. --sandbox turns
the shell sandbox on with a TMPDIR too long for its proxy socket, so the session makes its /tmp/octocode-sb-* folder.
EXIT_AUDIT_KEEP=1 keeps each run's root; EXIT_AUDIT_MEASURE_IDLE=1 times the shared octocode-mcp daemons' idle exit.
The shared octocode-mcp `serve` daemon and its language servers outlive the session by design and exit when idle.
Standard library only; every wait is bounded; the run kills and removes what it found before the next one.
"""

import argparse
import base64
import http.server
import json
import os
import re
import shutil
import signal
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
BUNDLE = f"{REPO}/packages/coding-agent/dist/bundle/cli.js"
RESOLVER = f"{REPO}/packages/coding-agent/scripts/source-resolver.ts"
SOURCE = f"{REPO}/packages/coding-agent/src/cli.ts"
VARIANTS = ["quit", "ctrlc", "pane", "killserver", "sigterm", "sigkill", "crash"]
# Variants that end the process from the keyboard need an idle editor; the rest end it mid-command.
IDLE_VARIANTS = {"quit", "ctrlc"}


# ---------------------------------------------------------------- scripted model (OpenAI chat completions, SSE)

def script(steps):
    return "B64SCRIPT:" + base64.b64encode(json.dumps(steps).encode()).decode()


def text_of(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


class Endpoint:
    def __init__(self):
        self.requests = []
        endpoint = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(404)
                self.send_header("content-length", "0")
                self.end_headers()

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
                endpoint.answer(self, body)

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def answer(self, handler, body):
        messages = body.get("messages", [])
        steps, index = [{"text": "no script"}], -1
        for at in range(len(messages) - 1, -1, -1):
            if messages[at].get("role") != "user":
                continue
            found = re.search(r"B64SCRIPT:([A-Za-z0-9+/=]+)", text_of(messages[at]))
            if found:
                steps, index = json.loads(base64.b64decode(found.group(1))), at
                break
        step = 0 if index < 0 else sum(1 for m in messages[index + 1:] if m.get("role") == "assistant")
        results = [text_of(m) for m in messages if m.get("role") == "tool"]
        self.requests.append({"at": time.time(), "step": step, "results": results, "tools": len(body.get("tools") or [])})
        current = {"text": "summary"} if not body.get("tools") else steps[min(step, len(steps) - 1)]
        handler.send_response(200)
        handler.send_header("content-type", "text/event-stream")
        handler.send_header("connection", "close")
        handler.end_headers()
        usage = {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105}

        def chunk(choice, extra=None):
            payload = {"id": "s", "object": "chat.completion.chunk", "created": 1, "model": body.get("model"),
                       "choices": [{"index": 0, **choice}], **(extra or {})}
            handler.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())

        if "tool" in current:
            args = dict(current.get("args", {}))
            if not current["tool"].startswith("mcp__"):
                args = {"reason": "scripted audit step", **args}
            call = {"index": 0, "id": f"call_{len(self.requests)}", "type": "function",
                    "function": {"name": current["tool"], "arguments": json.dumps(args)}}
            chunk({"delta": {"role": "assistant", "tool_calls": [call]}})
            chunk({"delta": {}, "finish_reason": "tool_calls"}, {"usage": usage})
        else:
            chunk({"delta": {"role": "assistant", "content": current["text"]}})
            chunk({"delta": {}, "finish_reason": "stop"}, {"usage": usage})
        handler.wfile.write(b"data: [DONE]\n\n")
        handler.wfile.flush()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


# ---------------------------------------------------------------- process and file snapshots

def processes():
    """pid -> {ppid, pgid, sid, start, command} for every process this account can see."""
    out = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,pgid=,lstart=,command="], capture_output=True, text=True,
                         timeout=20).stdout
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 8)
        if len(parts) < 9:
            continue
        pid = int(parts[0])
        try:
            sid = os.getsid(pid)
        except OSError:
            sid = -1
        table[pid] = {"pid": pid, "ppid": int(parts[1]), "pgid": int(parts[2]), "sid": sid,
                      "start": " ".join(parts[3:8]), "command": parts[8]}
    return table


def cwds_under(root):
    out = subprocess.run(["lsof", "-w", "-a", "-d", "cwd", "-F", "pn"], capture_output=True, text=True, timeout=30).stdout
    found, pid = set(), None
    for line in out.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None and (line[1:] + "/").startswith(root + "/"):
            found.add(pid)
    return found


def owned(root, main_pid, main_sid, table):
    """Processes this run started: descendants of main, its session, and anything naming or working in the root."""
    me = {os.getpid(), os.getppid()}
    children = {}
    for p in table.values():
        children.setdefault(p["ppid"], []).append(p["pid"])
    tree, stack = set(), [main_pid] if main_pid in table else []
    while stack:
        pid = stack.pop()
        if pid in tree:
            continue
        tree.add(pid)
        stack.extend(children.get(pid, []))
    found = set(tree)
    found |= {p["pid"] for p in table.values() if main_sid > 0 and p["sid"] == main_sid}
    found |= {p["pid"] for p in table.values() if root in p["command"]}
    found |= cwds_under(root) & set(table)
    found -= me
    return {pid: dict(table[pid], how="tree" if pid in tree else "detached") for pid in found
            if not table[pid]["command"].startswith(("tmux", "ps ", "lsof"))}


def files(root):
    """Sockets, locks, pid files and temp folders under the run's root (home and TMPDIR) and /tmp/octocode-sb-*."""
    found = set()
    for base, dirs, names in os.walk(root):
        rel = os.path.relpath(base, root)
        if rel.startswith("project") and ".git" in rel:
            continue
        for name in names:
            full = os.path.join(base, name)
            try:
                socket_file = stat.S_ISSOCK(os.lstat(full).st_mode)
            except OSError:
                continue
            if socket_file or re.search(r"\.(lock|pid|sock)$|lock$", name):
                found.add(os.path.relpath(full, root))
        if rel == "t" or rel.startswith("t/"):
            for name in dirs:
                found.add(os.path.relpath(os.path.join(base, name), root) + "/")
    for name in os.listdir("/tmp"):
        if name.startswith("octocode-sb-"):
            found.add("/tmp/" + name)
    return found


def alive(entry, table):
    now = table.get(entry["pid"])
    return now is not None and now["start"] == entry["start"]


# ---------------------------------------------------------------- one run

class Run:
    def __init__(self, mode, variant, endpoint, out, web=False, sandbox=False):
        self.mode, self.variant, self.endpoint, self.out = mode, variant, endpoint, out
        self.web, self.sandbox = web, sandbox
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="ea", dir="/tmp"))
        self.home, self.project = (os.path.join(self.root, n) for n in ("home", "project"))
        # Past 79 bytes the sandbox's proxy socket would not fit, so the session makes a short /tmp/octocode-sb-* folder.
        self.tmp = os.path.join(self.root, "t", "long-tmp-" + "x" * 80) if sandbox else os.path.join(self.root, "t")
        # Markers go in the project: the sandbox lets a command write there.
        self.markers = os.path.join(self.project, ".audit")
        self.daemon = None
        self.socket = f"exit-audit-{os.getpid()}-{variant}"
        self.log = []

    def idle(self):
        """Whether the session ends from an idle editor: needed by keyboard exits and to type `/web`."""
        return self.variant in IDLE_VARIANTS or self.web

    def note(self, text):
        self.log.append(f"{time.strftime('%H:%M:%S')} {text}")

    def tmux(self, *args, check=False):
        return subprocess.run(["tmux", "-L", self.socket, *args], capture_output=True, text=True, timeout=20, check=check)

    def screen(self):
        return self.tmux("capture-pane", "-p", "-t", "0").stdout

    def setup(self):
        agent_dir = os.path.join(self.home, ".octocode", "octocodecode")
        os.makedirs(agent_dir)
        os.makedirs(os.path.join(self.project, "src"))
        os.makedirs(self.tmp)
        os.makedirs(self.markers)
        model = {"id": "model", "name": "model", "contextWindow": 200000, "maxTokens": 8000, "input": ["text"],
                 "cost": {"input": 1, "output": 1, "cacheRead": 0.1, "cacheWrite": 1}}
        with open(os.path.join(agent_dir, "models.json"), "w") as f:
            json.dump({"providers": {"scripted": {"baseUrl": self.endpoint.url, "api": "openai-completions",
                                                    "apiKey": "local", "authHeader": True, "models": [model]}}}, f)
        with open(os.path.join(agent_dir, "settings.json"), "w") as f:
            json.dump({"sessionApiTurnPermission": "session", **({"sandbox": {"mode": "on"}} if self.sandbox else {})}, f)
        sources = {
            "a.txt": "hi\n",
            "src/math.ts": "export function addNumbers(a: number, b: number): number {\n\treturn a + b;\n}\n",
            "src/main.ts": 'import { addNumbers } from "./math.js";\n\nexport const total = () => addNumbers(1, 2);\n',
            "tsconfig.json": json.dumps({"compilerOptions": {"target": "ES2022", "module": "NodeNext",
                                                             "moduleResolution": "NodeNext", "strict": True},
                                         "include": ["src"]}),
            "package.json": json.dumps({"name": "fixture", "type": "module"}),
        }
        for name, content in sources.items():
            with open(os.path.join(self.project, name), "w") as f:
                f.write(content)
        with open(os.path.join(self.root, "hold.cjs"), "w") as f:
            f.write('require("node:fs").writeFileSync(process.argv[2], String(process.pid));'
                    'setInterval(() => {}, 60000);\n')
        with open(os.path.join(self.root, "crash.mjs"), "w") as f:
            f.write('process.on("SIGUSR2", () => setImmediate(() => { throw new Error("exit-audit crash"); }));\n')
        git = lambda *a: subprocess.run(["git", *a], cwd=self.project, capture_output=True, timeout=30, check=True)
        git("init", "-q")
        git("-c", "user.email=a@example.invalid", "-c", "user.name=a", "add", ".")
        git("-c", "user.email=a@example.invalid", "-c", "user.name=a", "commit", "-qm", "init")

    def hold(self, marker):
        return f"{json.dumps(sys_node())} {json.dumps(os.path.join(self.root, 'hold.cjs'))} {json.dumps(marker)}"

    def steps(self):
        marker = lambda name: os.path.join(self.markers, name)
        child = [{"tool": "bash", "args": {"command": self.hold(marker("child.pid")), "timeout": 280}},
                 {"text": "done: child"}]
        q = lambda **extra: {"mainGoal": "audit", "reasoning": "scripted", **extra}
        steps = [
            {"tool": "bash", "args": {"command": self.hold(marker("job.pid")), "background": True, "timeout": 280}},
            {"tool": "agent", "args": {"type": "task", "background": True, "goal": "hold a command",
                                       "task": script(child)}},
            {"tool": "mcp__octocode__localSearch", "args": {"queries": [q(path=".", matchString=["addNumbers"])]}},
            {"tool": "mcp__octocode__lspSearch", "args": {"queries": [q(operation="references", path="src/math.ts",
                                                                          symbolName="addNumbers", line=1)]}},
        ]
        if self.idle():
            steps.append({"text": "ready"})
        else:
            steps.append({"tool": "bash", "args": {"command": self.hold(marker("fg.pid")), "timeout": 280}})
        return steps

    def command(self):
        env = {"HOME": self.home, "USERPROFILE": self.home, "PATH": os.environ["PATH"], "TMPDIR": self.tmp + "/",
               "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "OCTOCODE_OFFLINE": "1",
               "OCTOCODE_SKIP_VERSION_CHECK": "1", "OCTOCODE_MODELS_DEV": "0"}
        if self.web:
            env.update({"SSH_CONNECTION": "127.0.0.1 1 127.0.0.1 2", "OCTOCODE_WEB_DAEMON_IDLE_MINUTES": "0.1"})
        node = [sys_node(), "--no-warnings"]
        if self.variant == "crash":
            node += ["--import", os.path.join(self.root, "crash.mjs")]
        node += [BUNDLE] if self.mode == "bundle" else ["--import", RESOLVER, SOURCE]
        args = ["--trust", "--offline", "--model", "scripted/model", script(self.steps())]
        return " ".join(json.dumps(p) for p in ["env", "-i", *(f"{k}={v}" for k, v in env.items()), *node, *args])

    def until(self, check, what, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if check():
                return True
            time.sleep(0.25)
        self.note(f"timed out after {seconds}s waiting for {what}")
        return False

    def main_pid(self):
        out = self.tmux("list-panes", "-t", "0", "-F", "#{pane_pid}").stdout.strip()
        return int(out) if out.isdigit() else None

    def end(self, pid):
        v = self.variant
        if v == "quit":
            self.tmux("send-keys", "-t", "0", "-l", "/quit")
            time.sleep(0.4)
            self.tmux("send-keys", "-t", "0", "Enter")
            # Quitting with running work asks first ("Running work: Stop ... and quit?"); the audit confirms.
            if self.until(lambda: "Running work" in self.screen(), "the quit confirmation", 10):
                self.note("confirming: " + " ".join(l.strip() for l in self.screen().splitlines() if "Stop " in l)[:200])
                # No is listed first: move to Yes, then pick it.
                self.tmux("send-keys", "-t", "0", "Down")
                time.sleep(0.3)
                self.tmux("send-keys", "-t", "0", "Enter")
        elif v == "ctrlc":
            self.tmux("send-keys", "-t", "0", "C-c")
            time.sleep(0.3)
            self.tmux("send-keys", "-t", "0", "C-c")
        elif v == "pane":
            self.tmux("kill-pane", "-t", "0")
        elif v == "killserver":
            self.tmux("kill-server")
        elif v in ("sigterm", "sigkill", "crash"):
            os.kill(pid, {"sigterm": signal.SIGTERM, "sigkill": signal.SIGKILL, "crash": signal.SIGUSR2}[v])

    def run(self):
        result = {"mode": self.mode, "variant": self.variant, "root": self.root}
        self.setup()
        files_before = files(self.root)
        self.tmux("new-session", "-d", "-x", "160", "-y", "48", "-c", self.project, self.command(), check=True)
        pid = self.main_pid()
        result["pid"] = pid
        self.note(f"main pid {pid}")
        wanted = ["job.pid", "child.pid"] + ([] if self.idle() else ["fg.pid"])
        ready = self.until(lambda: all(os.path.exists(os.path.join(self.markers, m)) for m in wanted)
                           and any(r["step"] >= 4 for r in self.endpoint_requests()), "every resource", 150)
        if self.idle():
            ready = ready and self.until(lambda: "ready" in self.screen(), "the idle editor", 30)
        if self.web and ready:
            ready = self.start_web()
        if self.sandbox:
            result["sandbox_dirs"] = sorted(n for n in os.listdir("/tmp")
                                            if n.startswith("octocode-sb-") and "/tmp/" + n not in files_before)
            ready = ready and bool(result["sandbox_dirs"])
            # The proxy socket is srt-mux-<pid>-<n>.sock: it names the process that owns the folder.
            for name in result["sandbox_dirs"]:
                self.note(f"{name}: {', '.join(sorted(os.listdir(os.path.join('/tmp', name))))}")
        time.sleep(3)
        result["ready"] = ready
        result["lsp_result"] = next((r["results"][-1][:300] for r in self.endpoint_requests() if r["step"] >= 4), "")
        result["screen_before"] = self.screen()
        table = processes()
        main_sid = table.get(pid, {}).get("sid", -1) if pid else -1
        before = owned(self.root, pid, main_sid, table) if pid else {}
        result["before"] = sorted(before.values(), key=lambda p: p["pid"])
        files_mid = files(self.root)
        started = time.time()
        self.end(pid)
        if not self.until(lambda: pid not in processes(), "the main process to exit", 20):
            result["screen_stuck"] = self.screen()
        result["main_exit_s"] = round(time.time() - started, 2)
        if self.daemon:
            # Its idle time is 6 s; the check runs every 1.5 s.
            gone = self.until(lambda: not alive(self.daemon, processes()), "the web daemon's idle exit", 30)
            result["web_daemon_exit_s"] = round(time.time() - started, 2) if gone else "alive after 30s"
        time.sleep(5)
        table = processes()
        survivors = {p["pid"]: p for p in before.values() if alive(p, table)}
        survivors.update(owned(self.root, -1, -1, table))
        if self.daemon and alive(self.daemon, table):
            survivors[self.daemon["pid"]] = self.daemon
        result["survivors"] = sorted(survivors.values(), key=lambda p: p["pid"])
        result["files_mid"] = sorted(files_mid - files_before)
        result["files_left"] = sorted(files(self.root) - files_before)
        result["log"] = self.log
        return result

    def start_web(self):
        """Types `/web item B1` and waits for the daemon's record; the daemon is tracked by pid and start time."""
        self.tmux("send-keys", "-t", "0", "-l", "/web item B1")
        time.sleep(0.4)
        self.tmux("send-keys", "-t", "0", "Enter")
        record = os.path.join(self.home, ".octocode", "octocodecode", "web", "daemon.json")
        if not self.until(lambda: os.path.exists(record), "the web daemon record", 60):
            return False
        pid = json.load(open(record)).get("pid")
        # The page address is printed once the session has attached.
        attached = self.until(lambda: "http://" in self.screen(), "the printed page address", 30)
        table = processes()
        self.daemon = dict(table[pid], how="web daemon") if pid in table else None
        self.note(f"web daemon pid {pid}, attached={attached}")
        return attached and self.daemon is not None

    def endpoint_requests(self):
        return self.endpoint.requests

    def measure_idle(self, result, limit=900):
        """Times how long each surviving serve daemon and its language servers take to exit on their own."""
        watched = [p for p in result.get("survivors", []) if " serve " in p["command"] or "--lsp" in p["command"]]
        started, exits = time.time(), {}
        while watched and time.time() - started < limit:
            table = processes()
            for p in watched:
                if p["pid"] not in exits and not alive(p, table):
                    exits[p["pid"]] = round(time.time() - started + 5, 1)
            if len(exits) == len(watched):
                break
            time.sleep(5)
        result["idle_exit_s"] = {label(p): exits.get(p["pid"], f"alive after {limit}s") for p in watched}

    def cleanup(self, result):
        self.tmux("kill-server")
        # tmux leaves its socket file behind when the server is killed.
        socket_dir = os.path.join(os.environ.get("TMUX_TMPDIR", "/tmp"), f"tmux-{os.getuid()}")
        try:
            os.unlink(os.path.join(socket_dir, self.socket))
        except FileNotFoundError:
            pass
        if os.environ.get("EXIT_AUDIT_MEASURE_IDLE"):
            self.measure_idle(result)
        table = processes()
        mine = [p for p in result.get("survivors", []) if alive(p, table)]
        for p in mine:
            try:
                os.kill(p["pid"], signal.SIGKILL)
            except OSError:
                pass
        for name in result.get("files_left", []):
            if name.startswith("/tmp/octocode-sb-"):
                shutil.rmtree(name, ignore_errors=True)
        if not os.environ.get("EXIT_AUDIT_KEEP"):
            shutil.rmtree(self.root, ignore_errors=True)


def sys_node():
    return shutil.which("node")


def label(p):
    command = re.sub(r"B64SCRIPT:\S+", "B64SCRIPT:…", p["command"])
    command = re.sub(r"/(private/)?tmp/ea\w+", "<root>", command)
    return f"{p['pid']} pgid={p['pgid']} sid={p['sid']} ppid={p['ppid']} [{p.get('how', '?')}] {command[:160]}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["bundle", "source"], default="bundle")
    parser.add_argument("--out", default=os.path.join(REPO, ".octocode", "tmp", "exit-audit"))
    parser.add_argument("--web", action="store_true")
    parser.add_argument("--sandbox", action="store_true")
    parser.add_argument("variants", nargs="*")
    options = parser.parse_args()
    variants = options.variants or VARIANTS
    unknown = sorted(set(variants) - set(VARIANTS))
    if unknown:
        parser.error(f"unknown variants {unknown}; choose from {VARIANTS}")
    os.makedirs(options.out, exist_ok=True)
    tag = options.mode + ("-web" if options.web else "") + ("-sandbox" if options.sandbox else "")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    summary = []
    for variant in variants:
        endpoint = Endpoint()
        run = Run(options.mode, variant, endpoint, options.out, web=options.web, sandbox=options.sandbox)
        result = {"mode": options.mode, "variant": variant}
        try:
            result = run.run()
        except Exception as error:  # a failed run is reported and the next one still runs
            result["error"] = repr(error)
            result["log"] = run.log
        finally:
            run.cleanup(result)
            endpoint.close()
        with open(os.path.join(options.out, f"{stamp}-{tag}-{variant}.json"), "w") as f:
            json.dump(result, f, indent=1)
        extra = f"web_daemon_exit={result.get('web_daemon_exit_s')}s " if options.web else ""
        extra += f"sandbox_dirs={result.get('sandbox_dirs')} " if options.sandbox else ""
        line = (f"## {tag} / {variant}: ready={result.get('ready')} exit={result.get('main_exit_s')}s {extra}"
                f"before={len(result.get('before', []))} survivors={len(result.get('survivors', []))} "
                f"files_left={len(result.get('files_left', []))} {result.get('error', '')}")
        lines = [line]
        lines += ["  before: " + label(p) for p in result.get("before", [])]
        lines += ["  SURVIVOR: " + label(p) for p in result.get("survivors", [])]
        lines += ["  file: " + f for f in result.get("files_left", [])]
        lines += ["  log: " + entry for entry in result.get("log", [])]
        lines += [f"  idle exit: {k} after {v}s" for k, v in result.get("idle_exit_s", {}).items()]
        print("\n".join(lines), flush=True)
        summary += lines
    with open(os.path.join(options.out, f"{stamp}-{tag}-summary.md"), "w") as f:
        f.write("\n".join(summary) + "\n")


if __name__ == "__main__":
    main()

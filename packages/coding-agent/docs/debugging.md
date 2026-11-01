# Native debugger

The `debug` tool is active by default; disable it with `octocode --tools -debug`. Provide an installed [DAP](https://microsoft.github.io/debug-adapter-protocol/overview) adapter. A launch starts the adapter and the debuggee; the host permission gate reviews the executable and launch arguments. All operations except `terminate` use the shared process permission gate. Read-only and isolated child roles refuse debugging because adapter-specific effects cannot be confined by their path guards.

## Supported and unsupported

| Supported                                                                                 | Not supported                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Launching a program with line breakpoints; replacing one file's breakpoints               | Attaching to a running process; core dumps                               |
| `continue`, `next` (step over), `stepIn`, `stepOut`, `pause`                              | Expression evaluation, watches, changing variables                       |
| Stopping on exceptions through the adapter's filters, with the exception message          | Conditional, hit-count, log, function and data breakpoints               |
| Stop reason, top frame, full `stack`, `scopes`, nested `variables`                        | `runInTerminal`; custom DAP requests; memory writes; installing adapters |
| Program output and exit code, also after the program ends                                 | Adapters that listen on a non-loopback address                           |
| Stdio adapters, and loopback TCP adapters with `startDebugging` child sessions (js-debug) |                                                                          |
| Other `launch` fields, passed to the adapter unchanged                                    |                                                                          |

## Adapters

The adapter runs without a shell: `adapter` is one executable and every further word goes in `adapterArgs`.

The tool's declaration names the supported adapters but not their recipes, to keep every request small: `launch` without `adapter` returns the recipes below in short form, with the input limits, starts nothing and needs no permission.

| Language                              | `adapter` and `adapterArgs`                                                            | Typical `launch`                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C, C++, Rust, Swift (macOS)           | `xcrun`, `["lldb-dap"]`                                                                | `{ "program": "/abs/path/bin", "args": [], "cwd": "/abs/dir" }`                                                                                                                                     |
| C, C++, Rust, Swift (Linux)           | `lldb-dap`, `[]`                                                                       | as above                                                                                                                                                                                            |
| Python, with `debugpy` installed      | `python3`, `["-m", "debugpy.adapter"]`                                                 | `{ "program": "/abs/path/script.py", "console": "internalConsole", "redirectOutput": true, "subProcess": false }`, or `"module": "pytest", "args": ["-x", "tests/test_a.py"]` in place of `program` |
| Node.js and TypeScript, with js-debug | `node`, `["/abs/js-debug/src/dapDebugServer.js", "0", "127.0.0.1"]`, and `"tcp": true` | `{ "type": "pwa-node", "program": "/abs/path/app.ts", "cwd": "/abs/dir", "outputCapture": "std" }`                                                                                                  |
| vitest, with js-debug                 | as above                                                                               | `{ "type": "pwa-node", "program": "/abs/repo/node_modules/vitest/vitest.mjs", "args": ["run", "test/a.test.ts"], "cwd": "/abs/package", "outputCapture": "std" }`                                   |

lldb-dap and debugpy speak DAP over stdio when started without a port or connection option. debugpy's default `console` is `integratedTerminal`, which needs the `runInTerminal` reverse request this tool refuses; set `internalConsole`, and `redirectOutput` to capture program output ([debugpy settings](https://github.com/microsoft/debugpy/wiki/Debug-configuration-settings)). debugpy also debugs subprocesses by default through its own attach flow, which this tool does not follow: a program that starts a subprocess then stays `running` and never reaches its breakpoints. Set `subProcess: false`; the subprocess then runs undebugged. Build native programs with debug symbols (for example `cc -g -O0`).

Install js-debug from the `js-debug-dap-v<version>.tar.gz` asset of a [vscode-js-debug release](https://github.com/microsoft/vscode-js-debug/releases) and point `adapterArgs` at its `src/dapDebugServer.js`. If you unpack it inside a package whose `package.json` sets `"type": "module"`, add `{ "type": "commonjs" }` as `package.json` in the unpacked folder, because the server is a CommonJS bundle. With `"tcp": true` the tool reads the loopback `listening at host:port` line the server prints (port `0` lets it choose a free port) and connects only to `127.0.0.1`, `localhost` or `::1`. js-debug starts each Node process and worker as a child session through `startDebugging`; the tool honors that request only from the adapter it started, opens another connection to the same address, and sends the current breakpoints and exception filters to it. Its default `outputCapture` is `console`, which misses `process.stdout` writes such as vitest's summary; `std` captures them. Node's built-in type stripping runs `.ts` files directly, and breakpoints in vitest test files bind through source maps. Other loopback TCP adapters that print such a line may work but are untested.

## Call sequence

```json
{
	"action": "launch",
	"adapter": "xcrun",
	"adapterArgs": ["lldb-dap"],
	"launch": { "program": "/abs/path/sum", "cwd": "/abs/path" },
	"breakpoints": [{ "source": "/abs/path/sum.c", "lines": [4] }],
	"exceptions": ["cpp_throw"]
}
```

`launch`, `continue`, `next`, `stepIn`, `stepOut`, `pause` and `output` wait up to 30 seconds for the next stop or the end of the program, then return:

- `state`: `stopped`, `running` (still running after the wait) or `ended`;
- `generation`: the stop number that inspection and stepping calls must pass;
- at a stop: `reason` (for example `breakpoint`, `step`, `exception`, `pause`), `description` or `text` when the adapter gives them, `threadId`, and `frame` (`id`, `name`, `source`, `line`) for the top frame;
- at an exception stop: `exception` (`id`, `description`, `message`) when the adapter supports `exceptionInfo`;
- after the end: `exitCode` when the adapter reports one (js-debug does not);
- `output`: program and adapter output since the last call (DAP telemetry is dropped);
- `next`: the call that usually follows.

The launch result also lists each breakpoint the adapter verified or rejected, and `exceptions`: the filter ids the adapter offers (`available`), the requested ones it accepted (`enabled`) and the requested ones it does not know (`unknown`, not sent). js-debug reports breakpoints as provisional (`verified: false`) until the script loads; they still bind. If `state` is `running`, call `output` to wait again, `pause` to stop the program where it is, or `terminate`. At a stop, call `scopes` with `frame.id` (or a frame `id` from `stack`), then `variables` with a `variablesReference` from scopes; a variable with a reference above 0 opens the same way. `stack` lists up to 100 frames. A resume invalidates the generation, frame IDs and references; use the values from its result. Generations can jump by more than one, because the adapter's continue and stop events each advance them. `breakpoints` replaces the breakpoints for one source on every session, and `lines: []` clears them. After the program ends, `output` still returns its final output and exit code; other actions fail until a new `launch`, which replaces the ended session. `terminate` stops child sessions, then the session, then the adapter process; if the adapter does not confirm, the result says so and the process is stopped anyway. A session switch, fork or shutdown asks the adapter to end the debuggee (DAP `terminate`, else `disconnect` with `terminateDebuggee`), waits at most 2 seconds, then stops the adapter, so a debuggee does not outlive its session.

One adapter runs per native session, with up to 16 child sessions, a 1 MiB message bound, 10 second request deadline, 100-item inspection cap and 24,000-character output tail. Output is passed through as the adapter sends it; lldb-dap uses `\r\n` line endings and adds its own "Process … exited" line.

## Exception filters

The ids come from the adapter: js-debug offers `all` and `uncaught`; lldb-dap offers `cpp_throw`, `cpp_catch` and their Objective-C and Swift variants; debugpy offers filters such as `raised` and `uncaught`. Node treats an error thrown while an ES module is evaluated as caught by the module loader, so `uncaught` does not stop there; use `all` for ES modules (`"type": "module"` packages, `.mjs`, and `.ts` files under them). A pause through lldb-dap reports `reason: "exception"` with the description `signal SIGSTOP`; that is the pause, not a crash.

## Techniques

- **Wrong value:** break on the line that computes it, read the locals, then `next` and compare the step result's `frame` and locals line by line.
- **Wrong path taken:** break on the branch condition and read the variables it tests; `stepIn` to follow the call that decides it.
- **Crash or thrown error:** launch with `exceptions` (`all` for Node ES modules, `uncaught` for CommonJS, `cpp_throw` for C++) and no breakpoints; the stop names the throwing frame and the exception message.
- **Hang or busy loop:** launch without breakpoints; when the result says `running`, `pause` and read `stack` to see where it is (in native code the top frames may be system calls; look further down).
- **One failing test:** for pytest, launch `{ "module": "pytest", "args": ["-x", "tests/test_a.py::test_name"], "console": "internalConsole", "subProcess": false }`; for vitest, use the js-debug row above with the test file in `args`. Put a breakpoint inside the test or the code under test.
- **Unexplained exit:** launch without breakpoints; the result reports `ended`, the exit code and the last output.

Debugger observations can explain a failing branch; rerun the original regression test after a file fix to verify it.

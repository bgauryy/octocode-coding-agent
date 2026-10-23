# Optional native debugger

Enable the `debug` tool with `octocode --tools +debug` and provide an installed stdio [DAP](https://microsoft.github.io/debug-adapter-protocol/overview) adapter executable. A launch starts the adapter and the debuggee; the host permission gate reviews the executable and launch arguments. All operations except `terminate` use the shared process permission gate. Read-only and isolated child roles refuse debugging because adapter-specific effects cannot be confined by their path guards. The tool does not install adapters, attach to existing processes, evaluate expressions, run custom DAP requests, write memory or satisfy an adapter's `runInTerminal` request.

For an adapter whose launch arguments include `program`, an illustrative call is:

```json
{"action":"launch","adapter":"/path/to/installed/adapter","adapterArgs":[],"launch":{"program":"/absolute/path/to/program"},"breakpoints":[{"source":"/absolute/path/to/source.ts","lines":[17]}]}
```

Adapter launch schemas differ. Supply only arguments supported by the selected adapter. The response reports actual verified or unverified breakpoints, current state and stop generation. If running, read `output` later to obtain the new state. At a stop, call `stack` with that generation and optional thread ID; then `scopes` with a frame ID returned by stack, and `variables` with a reference returned by scopes. `continue`, `next`, `stepIn` and `stepOut` require the current generation and optional thread ID. A resume invalidates all frame and variable references; use the new generation after the next stop. `breakpoints` replaces the breakpoints for one source. `output` drains the bounded adapter output. `terminate` ends the session and owned adapter process.

The first increment uses one adapter per native session and a 1 MiB message bound, 10 second request deadline, 100-item inspection cap and 24,000-character output tail. An adapter that requires client reverse requests such as terminal launch cannot use this tool. Debugger observations can explain a failing branch; rerun the original regression test after a file fix to verify it.

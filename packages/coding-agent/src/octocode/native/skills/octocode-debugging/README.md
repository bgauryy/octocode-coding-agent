# Octocode Debugging

Bundled with Octocode. It teaches agents to debug and profile running programs through `bash`: breakpoints and locals with lldb, gdb, pdb and a Node inspector script, crashes and hangs; CPU functions/callers, allocations, process resources, event-loop/GC timing, I/O and browser/GPU profiling. The profiling reference distinguishes what each capture measures and what remains unmeasured. Every run is a batch command that finishes on its own, so it passes the shell permission gate like any other command.

- Start at [SKILL.md](SKILL.md).
- Output: the cause with the evidence that proves it ([output.md](output.md)); profiles and logs go under `<workspace>/.octocode/octocode-debugging/`.
- Profiling: [workflow and coverage](references/profiling.md), [CPU/heap summaries](scripts/profile-top.mjs), and the [Node metrics preload](scripts/node-metrics.mjs). GPU and native tracing need platform tools; Node sampling alone cannot measure them.
- On demand: memory/GC/retention, Rust, Go, browser/GPU timelines, host usage, controlled experiments and debugger techniques are references; `metrics-report.mjs` charts a metrics capture and `native-capture.sh` records one PID's native stacks.
- Setup: the system debugger for the language (`lldb` with Xcode command line tools on macOS, `gdb` on Linux, Python's `pdb`). The scripts need Node 22 or later and nothing else.

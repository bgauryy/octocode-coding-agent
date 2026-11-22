---
name: octocode-debugging
description: "Use to debug crashes, hangs, deadlocks or wrong values (breakpoints, stacks, locals), or to profile bottlenecks, leaks or slowness: CPU, memory, event loop, GC, I/O, browser, GPU."
---

# Octocode Debugging

Run the program, stop it where it goes wrong, and read the real values instead of guessing from source. Every command runs through `bash` and must finish on its own: debuggers run in batch mode with their commands on the command line and stdin closed (`</dev/null`), never as an interactive prompt. Read code and logs first; for a profiling request, establish the workload and baseline before recording.

## Reproduce first

Find the smallest command that shows the failure (one test, one input, one request), run it once without a debugger and keep its output: it is the check you rerun after the fix. If it is intermittent, loop it (`for i in $(seq 20); do <cmd> || break; done`) before attaching anything. Narrowing a failing input or a bad revision: [experiments](references/experiments.md).

For stepping and locals, build native code with debug information and no optimization (`-g -O0`, `cargo build` without `--release`, `go build -gcflags=all="-N -l"`). For performance, keep production optimization and add symbols.

## Pick the tool

| Program             | Stop and inspect                                                         | Read                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C, C++, Rust, Swift | `lldb -b -o "b file.c:12" -o run -o "frame variable" -o bt -- ./prog`    | [native](references/native.md)                                                                                                                               |
| Go                  | `dlv` when installed, or stack dumps with `SIGQUIT`                      | [native](references/native.md), [go](references/go.md)                                                                                                       |
| Python              | `python3 -m pdb -c "b file.py:12" -c c -c "p x" -c q prog.py </dev/null` | [python](references/python.md)                                                                                                                               |
| Node, TypeScript    | `node scripts/node-break.mjs --break file.ts:12 -- file.ts`              | [node](references/node.md)                                                                                                                                   |
| Slow or memory      | The language's profiler, then a top-N summary                            | [profiling](references/profiling.md), [memory](references/memory.md), [rust](references/rust.md), [gpu](references/gpu.md), [host](references/host-usage.md) |

`scripts/` is this skill's directory (`<skill>` in references; loading the skill reports it). Linux has `gdb -batch -ex ...` where macOS has `lldb -b -o ...`. Watchpoints, dumps and replay: [debugger techniques](references/debugger-techniques.md).

## Wrong value or path

Break on the line where the value is first wrong, not where it is used. Print locals and stack; when the line runs many times add a condition (`file:line:condition` in node-break, `-c cond` in lldb, `b file:line, cond` in pdb) or cap the pauses. If the input to that line is already wrong, move the breakpoint to its producer and rerun. Prefer several narrow runs over one that prints everything.

## Crash or exception

Stop where it fails: lldb stops on the signal and runs `-k` commands, pdb enters post-mortem, node-break pauses with `--exceptions all` (the first event is usually the one). Read the innermost frame in your own code, not the library frame on top, and print the arguments that reached it.

## Hang

Dump every thread's stack twice, a few seconds apart: frames that stay the same are where it is stuck. `sample <pid> 3` (macOS), `gdb -p <pid> -batch -ex "thread apply all bt"` or `py-spy dump --pid <pid>` (Linux), `faulthandler.dump_traceback_later` (Python), `--timeout` in node-break. A wait on a lock, pipe or socket points at the other side: find what should have released or written it.

## Slow or memory-heavy

Read [profiling](references/profiling.md) before recording: name the workload, runtime, headless/visible mode and duration; start with wall time and the process tree, then pick CPU stacks, allocations/retention, event loop/GC, I/O or browser/GPU from the symptom. Inspect self and inclusive cost; sampling does not count invocations and waiting is not CPU. Test the leading hotspot against a rival explanation, then repeat the same workload. One heap sample is not a leak and one run is not a speedup: prove a speedup against a baseline over repeated runs of the same workload.

## Rules

- Always set a timeout or cap (`--timeout`, `--max-hits`, `faulthandler`, a bounded loop). Keep stdin/TTY only for a terminal workload whose rendering you measure; run long captures in the background. Stop only processes you started.
- Check tools with `command -v`. Do not install tools, escalate privileges, signal peer sessions or expose an inspector without authorization. Profiles hold paths and data: keep them local. Heap snapshots pause the process and can need twice its heap: ask first on a live session.
- Remove temporary `debugger;`, `breakpoint()` and debug prints, and check with a search.
- State the cause with evidence: the line, the value seen and the value it should have been. After the fix, rerun the reproduction and affected tests.

## Scripts

`node-break.mjs` (Node breakpoints), `profile-top.mjs` (`.cpuprofile`/`.heapprofile` top rows), `node-metrics.mjs` (preload: CPU, memory, loop, GC), `metrics-report.mjs` (HTML chart of that JSONL), `native-capture.sh` (stacks of one PID). Usage: [profiling](references/profiling.md), [node](references/node.md). Bisecting, spikes, request tracing: [experiments](references/experiments.md).

## Related skills

- `octocode-local-research` (`octocode-github-research` for code outside this checkout): what the code does or who calls it, before running anything.
- `octocode-chrome-devtools`: failures in a web page (console, network, page debugger).

Report per [output.md](output.md).

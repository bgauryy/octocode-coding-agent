# Output

A short report in task terms.

- **Cause:** the file and line, the value or state observed there, what it should have been, and the command that showed it.
- **Fix:** what changed, and the reproduction and tests rerun after it with their result.
- **Profiling:** workload/input size, command/action, runtime/build, headless/visible mode, capture duration/sample count and artifact paths. Give CPU self/inclusive hotspots, memory trend and allocation/retention distinction, process/tree ownership, loop/GC timing and I/O/GPU evidence where measured. State units, profiler overhead and uncovered dimensions. If code changed, compare repeated identical uninstrumented runs; otherwise name the next experiment, not an invented speedup.
- **Not established:** what the runs could not show (for example a race that did not reproduce, or a build without debug information).

Save profiles, debugger logs and scratch programs to `<workspace>/.octocode/agent/octocode-debugging/`.

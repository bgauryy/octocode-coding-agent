Load when a program is slow or uses too much memory, in any language.

# Profiling

Time the reproduction first (`time <cmd>`, or the test runner's duration) and keep that command: the same command proves the fix. Profile a run long enough to sample well (a second or more); loop a fast operation if needed. Read the top rows, not the whole profile.

- **Self** cost is spent in the function's own code: fix it there.
- **Total** cost includes what it calls: a high total with a low self means the cost is below it, often a call made too many times.
- Garbage collection near the top means allocation is the cost: look at the memory profile.

Save profiles under `<workspace>/.octocode/octocode-debugging/`.

## Node and TypeScript

```bash
node --cpu-prof --cpu-prof-dir=.octocode/octocode-debugging src/main.ts
node <skill>/scripts/profile-top.mjs .octocode/octocode-debugging --top 15
node <skill>/scripts/profile-top.mjs .octocode/octocode-debugging --sort total --filter src/
```

[profile-top.mjs](../scripts/profile-top.mjs) reads the newest `.cpuprofile` or `.heapprofile` in a directory (or a named file) and prints self and total cost per function with its location. `--filter` keeps functions whose name or path contains the text; filtering on your source directory hides Node internals.

Memory: `node --heap-prof --heap-prof-dir=<dir>` writes a `.heapprofile` at exit that profile-top reads the same way; its bytes are allocations still live then, so data that was freed does not show. Lower `--heap-prof-interval` (bytes, default 524288) for a small program. For a leak, compare `process.memoryUsage().heapUsed` across repeated runs of the operation, and use `--heapsnapshot-near-heap-limit=1` for a crash on the heap limit.

Inside test runners the profile also contains the runner: filter on your source path.

## Python

```bash
python3 -m cProfile -s tottime app/main.py 2>&1 | head -25     # tottime: self; cumtime: total
python3 -m cProfile -o .octocode/octocode-debugging/run.prof app/main.py
python3 -c "import pstats; pstats.Stats('.octocode/octocode-debugging/run.prof').sort_stats('cumtime').print_stats(20)"
```

Memory: `python3 -X tracemalloc=5 app/main.py` with a snapshot at the point of interest, `tracemalloc.take_snapshot().statistics("lineno")[:10]`, lists the lines holding the most memory. With py-spy installed, `py-spy top --pid <pid>` and `py-spy record -o out.svg -- python3 app/main.py` sample without changing the program.

## Native

- macOS: `sample <pid> 5` prints a call tree with sample counts; `xcrun xctrace record --template "Time Profiler" --launch -- ./prog` records a trace for Instruments.
- Linux: `perf record -g ./prog` then `perf report --stdio --no-children | head -40`; `valgrind --tool=massif ./prog` and `ms_print` for heap growth.
- Go: `go test -cpuprofile cpu.out -memprofile mem.out -bench .` then `go tool pprof -top cpu.out`.
- Rust: build with `debug = true` under `[profile.release]` so the profile has names, then use the platform profiler above.

## After the change

Run the same command the same way and report both numbers. For a small difference repeat each run several times and compare medians; one run does not prove a speedup.

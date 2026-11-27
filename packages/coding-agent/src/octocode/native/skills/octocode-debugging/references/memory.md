Load when memory grows, GC dominates, RSS disagrees with heap numbers, native code leaks or corrupts memory, or data structures cost more than expected.

# Memory: GC, heap, retention, allocators

Coarse counters first ([profiling](profiling.md)), then the one capture that separates the rivals.

## Name the memory

| Number                      | Counts                                                    | Read with                                                                        |
| --------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| RSS                         | Pages in RAM: heap, stacks, code, mapped files, libraries | Linux `/proc/$pid/smaps_rollup`, `pmap -x`; macOS `vmmap --summary`, `footprint` |
| Managed heap used/committed | Live objects plus uncollected garbage / reserved          | Runtime GC log or counters (below)                                               |
| Native heap                 | `malloc`, `new`, buffers owned by native libraries        | Allocation profiler, allocator statistics                                        |
| Shared/mapped               | Mappings, shared libraries                                | Per-mapping `smaps`; summing processes double-counts                             |

RSS growing while the managed heap after GC is flat means native memory, buffers, allocator retention, JIT code or mappings.

## Churn, retention or peak

| Question  | Evidence                                                                  | Capture                                                                               |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Churn     | Allocation rate, GC frequency and CPU share                               | Allocation sampling over a fixed operation count; divide by operations                |
| Retention | Heap after GC at the same lifecycle point rising across equivalent cycles | Snapshots or live profiles at cycles 1, k, 2k (at least ten cycles); diff             |
| Peak      | High-water mark, OOM kills, container limit hits                          | Time series across the spike plus the allocation tree at the peak (Massif, heaptrack) |

Cumulative allocation (`alloc_space`) answers churn, in-use views answer retention; one snapshot proves neither. Prove a leak by a slope over cycles after cleanup, a cache by its plateau.

## GC

| Runtime | Log or events                            | Live counters                                       | Knobs                                     |
| ------- | ---------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| Node    | `--trace-gc`, `PerformanceObserver` `gc` | `process.memoryUsage()`, `v8.getHeapStatistics()`   | `--max-old-space-size`                    |
| JVM     | `-Xlog:gc*:file=gc.log`                  | `jstat -gcutil $pid 1000`, `jcmd $pid GC.heap_info` | collector, `-Xmx`, `-XX:MaxRAMPercentage` |
| Go      | `GODEBUG=gctrace=1`                      | `runtime.ReadMemStats`                              | `GOGC`, `GOMEMLIMIT`                      |
| .NET    | `dotnet-trace` GC events                 | `dotnet-counters monitor -p $pid`                   | server vs workstation GC                  |
| Python  | `gc.set_debug(gc.DEBUG_STATS)`           | `gc.get_stats()`                                    | `gc.set_threshold`                        |

| Pattern                             | Meaning            | Next                                                                |
| ----------------------------------- | ------------------ | ------------------------------------------------------------------- |
| High GC share, heap after GC flat   | Churn              | Cut allocations at top sites: reuse buffers, pre-size, avoid copies |
| Heap after GC rises per cycle       | Retention          | Snapshot diff, retainer path                                        |
| Near limit, back-to-back full GCs   | Thrash before OOM  | Find the retention; a bigger limit only delays a leak               |
| Runtime limit above container limit | Kernel kills first | Set the heap limit below the cgroup limit with native headroom      |

Force a GC (`--expose-gc`, `System.gc()`, `runtime.GC()`, `gc.collect()`) only to measure, at the same point each cycle. Never rely on finalizers to release scarce resources.

## Snapshots and retainers

Rank by retained size to find owners, by count to find what multiplies. A retainer path from a GC root names the anchor (module map, listener list, timer, cache, closure). Three-snapshot method: warm up, snapshot A, run N cycles, B, N more, C; objects allocated between A and B still alive in C are candidates. Snapshots pause the process and can need as much memory as the heap.

| Runtime | Capture                                                                  | Read with                                                                   |
| ------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Node    | `v8.writeHeapSnapshot()`, `--heapsnapshot-signal=SIGUSR2`, `--heap-prof` | DevTools Memory; `profile-top.mjs` for `.heapprofile`                       |
| JVM     | `jcmd $pid GC.heap_dump /abs/heap.hprof`, `GC.class_histogram`           | Eclipse MAT, VisualVM                                                       |
| Go      | `/debug/pprof/heap`                                                      | `go tool pprof -inuse_space`, `-alloc_space`, `-base old new` ([go](go.md)) |
| Python  | `tracemalloc` `compare_to`, `gc.get_referrers`                           | Memray if installed                                                         |
| .NET    | `dotnet-gcdump collect -p $pid`                                          | PerfView; diff two dumps                                                    |

## References and pointers

| Kind                                      | Failure                                                 | Shows as                                  |
| ----------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| Strong                                    | Forgotten owner (listener, cache, global map, closure)  | Retainer path ends at the owner           |
| Weak (`WeakRef`, `WeakMap`, `Weak`)       | Used as a cache: entries vanish at GC                   | Hit rate varying with GC                  |
| Finalizer/`Cleaner`                       | Runs late or never                                      | Native resources outlive wrappers         |
| Refcount (`Rc`, `Arc`, `shared_ptr`, ARC) | Cycles never reach zero (CPython has a cycle collector) | Count stays up; use a weak back-reference |
| Raw/borrowed                              | Dangling after free or move                             | Use-after-free, far-away crashes          |

| Native bug                            | Tool                                            |
| ------------------------------------- | ----------------------------------------------- |
| Use-after-free, double free, overflow | `-fsanitize=address -g`                         |
| Leak at exit                          | LeakSanitizer, macOS `leaks --atExit -- ./prog` |
| Uninitialized read                    | MemorySanitizer or Valgrind Memcheck            |
| Undefined arithmetic/alignment        | `-fsanitize=undefined`                          |
| Unsafe Rust aliasing                  | `cargo +nightly miri test`                      |

Sanitizers see only the paths the run executes: drive them with the failing input.

## Lists and layout

- Linked nodes cost header plus pointers per node and cache misses; prefer arrays or index arenas. Growing arrays move elements: pointers into them dangle.
- Go subslices retain the whole backing array (copy with `slices.Clone`); V8 sliced strings, Go substrings and `Buffer.slice` retain their parent.
- Boxed lists (`ArrayList<Integer>`, Python list of ints) cost an object per element: use primitive arrays, `array`, NumPy, typed arrays. Python instances carry a `__dict__` unless `__slots__`.
- Struct field order changes size: `struct{char a;double b;char c;}` is 24 bytes, `{double b;char a;char c;}` 16. Check `sizeof`/`offsetof`/`pahole -C T ./bin`, Rust `size_of`, Go `unsafe.Sizeof`, Java JOL. Large by-value structs show as `memcpy` in CPU samples. Pad per-thread counters to a cache line.

## malloc family

| Call        | Bug to look for                                                                             |
| ----------- | ------------------------------------------------------------------------------------------- |
| `malloc(n)` | Read before write, unchecked `NULL`, `count * size` overflow                                |
| `calloc`    | Overflow-checked and zeroed; large blocks are already zero, cost shows on first touch       |
| `realloc`   | Block may move; `p = realloc(p, n)` leaks on failure                                        |
| `free`      | Double free, foreign pointer, use after free; memory may not return to the OS               |
| Pairing     | `malloc`↔`free`, `new`↔`delete`, `new[]`↔`delete[]`; do not mix allocators across libraries |

RSS moves without a leak when glibc per-thread arenas grow (`MALLOC_ARENA_MAX`, `malloc_trim(0)`), fragmentation pins pages, or overcommit defers the OOM kill to first touch. Profile with the production allocator.

| Platform | Allocation profiling                                                                               | Debug checks                               |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Linux    | `heaptrack ./prog`, Massif ([rust](rust.md)), jemalloc `MALLOC_CONF=prof:true`                     | ASan, `MALLOC_CHECK_=3`, `MALLOC_PERTURB_` |
| macOS    | `MallocStackLogging=1` then `leaks`, `heap`, `malloc_history $pid <addr>`; Instruments Allocations | `MallocScribble=1`, `MallocGuardEdges=1`   |
| Rust     | `dhat`, tools above                                                                                | Miri, nightly ASan                         |

## Practices

Profile with production's allocator, flags and limits. Measure per operation (bytes per request, retained bytes per cycle). Fix at the owner (release, unsubscribe, bound the cache, close the handle); forced GC, a bigger heap or unowned manual frees hide the cause. Bound every cache and queue keyed by request ids.

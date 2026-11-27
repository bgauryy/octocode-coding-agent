Load when profiling a Rust program. Breakpoints and crashes: [native](native.md).

# Rust profiling

## Build

Keep production features, optimization, allocator and workload; add symbols (`[profile.release] debug = "line-tables-only"`, `strip = "none"`, or env `CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=none cargo build --release --bin <bin>`). Full debug info is needed only for locals. If unwinding fails use `perf --call-graph dwarf` or `RUSTFLAGS="-C force-frame-pointers=yes"` (keep existing RUSTFLAGS, disclose the change). Never compare a debug baseline with a release candidate. Match binary, symbols and source revision with the capture.

| Question       | First capture                                              | Next                                         |
| -------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Busy core      | Native sampled stacks                                      | Self cost, callers, operation counts         |
| Slow, low CPU  | Request spans plus every thread's stacks                   | Lock owner, queue wait, downstream I/O       |
| Uneven threads | Linux `pidstat -t -p <pid> 1 5`, Instruments thread tracks | Runnable vs blocked, pool saturation         |
| RSS grows      | RSS series plus allocation profiler                        | Live vs total allocated; allocator retention |
| Tokio stalls   | `tracing` spans, Tokio Console if instrumented             | Poll duration, busy/idle, waits              |

```bash
bash <skill>/scripts/native-capture.sh "$pid" "$seconds" "$out/stacks"   # verified PID
perf record --call-graph dwarf -o <cap>/perf.data -- target/release/<bin> <args>
perf report -i <cap>/perf.data --stdio --no-children
cargo flamegraph --bin <bin> -o <cap>/flamegraph.svg -- <args>          # if installed
```

macOS: Instruments Time Profiler (`xcrun xctrace list templates`, set a time limit) or `samply`.

## Memory

Linux with Valgrind: `valgrind --tool=massif --massif-out-file=<cap>/massif.out target/release/<bin>`, then `ms_print`. Massif shows heap near the peak, changes timing a lot and can be hidden by a custom arena; on macOS use Instruments Allocations. Separate churn (total allocated), retention (outstanding) and RSS; require growth after cleanup over repeated cycles before claiming a leak. Ownership does not preclude retained caches, `Arc` cycles or unbounded queues: inspect the release path at the measured stacks before adding manual frees.

## Async timelines

Native stacks show threads, not suspended futures. Add `tracing` spans at request, queue, lock, I/O and CPU boundaries with IDs and sizes, not payloads (`#[tracing::instrument(skip_all, fields(request_id = %id))]`, `.instrument(span)` for futures; never hold `span.enter()` across `.await`). Tokio Console needs `console-subscriber` in the app and cannot attach to an arbitrary PID. For a Chrome-format timeline add an opt-in `tracing-chrome` layer to the existing subscriber, run a finite workload, drop the guard to flush, open the JSON in Perfetto; `include_args(true)` exports span field values, so audit them first. It shows emitted spans, not CPU samples, and span lifetime includes waits.

Load when profiling or diagnosing a Go program.

# Go diagnostics

## Already running with `net/http/pprof`

Verify the instance (a load-balanced URL can switch instances), use its private base URL (for example `http://127.0.0.1:6060/debug/pprof`), drive the workload **during** each recording, one capture at a time. `$base`, `$out` (existing private directory), `$seconds`.

| Question                | Capture                                                                                       | Inspect                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CPU                     | `curl -fsS "$base/profile?seconds=$seconds" -o "$out/cpu.pprof"`                              | `go tool pprof -top "$out/cpu.pprof"`, then `-top -cum` for callers                                                           |
| Stalled goroutines      | `curl -fsS "$base/goroutine?debug=2" -o "$out/g1.txt"` during the stall; repeat to a new file | Follow blocked goroutines to the lock, channel or dependency that wakes them; a parked background goroutine can be healthy    |
| When work ran or waited | `curl -fsS "$base/trace?seconds=$seconds" -o "$out/trace.out"`                                | `go tool trace`; batch: `go tool trace -pprof=sched "$out/trace.out" > "$out/sched.pprof"`. Runnable time is scheduling delay |
| Retained or allocated   | `curl -fsS "$base/heap" -o "$out/heap.pprof"` at comparable GC points                         | `-inuse_space` is sampled live bytes, `-alloc_space` cumulative including freed                                               |

The block profile attributes synchronization delay to waiting stacks and the mutex profile contention to holder stacks, if enabled; record the rates. Go's default `SIGQUIT` handler dumps stacks **and exits**: use the goroutine endpoint on a live service. Goroutine IDs and OS thread IDs differ; use trace tasks and regions to follow a request across goroutines.

## Launch

```bash
go test -run '^$' -bench '^BenchmarkWork$' -cpuprofile "$out/cpu.pprof" -o "$out/pkg.test" .
go tool pprof -top "$out/pkg.test" "$out/cpu.pprof"
```

For scheduling, run separately with `-trace "$out/trace.out"`. Keep the binary for symbolization and input and concurrency comparable to the service. For a wrong value use `dlv debug` or `dlv test` on a disposable build; `dlv attach` can pause a live service.

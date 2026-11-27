Load when several explanations fit one observation, a failing input is large, a regression spans revisions, or a spike or slow request must be located.

# Controlled experiments

| Observation                        | Rivals                                                        | Discriminating evidence                                                            |
| ---------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Tail latency up, process CPU low   | Downstream I/O, contended local lock, starved runnable worker | Same-request dependency span, lock owner/waiter, runnable-to-running delay         |
| RSS climbs, managed heap flat      | Native retention or allocator reserve                         | Outstanding native allocations and mappings after equivalent cycles                |
| Failure disappears at a breakpoint | Race, or changed input or order                               | Same input and concurrency; low-overhead events around the first divergent handoff |

## Narrow a failure

Define a precise check for _this_ failure, then remove input chunks or operations while it still fails (delta debugging); keep dependencies the input needs, since a parse error from the reduction is a different failure. A small reproducer shows the conditions; a runtime observation still locates the code.

For a regression between a known good and bad revision, drive `git bisect run` with a repeatable script in a disposable checkout (never in a shared tree): exit 0 good, 1 bad, 125 untestable. Flaky outcomes mislead bisect: recheck the boundary with the same input and environment.

## Catch a spike

Record before, during and after the trigger, at a resolution that fits the burst (a one-second average hides a ten-millisecond spike; quantiles cannot be differenced across windows). Note missed events and delayed samples. Add boundary events only for a missing observation, with a correlation ID, timing, input size or phase; no sensitive payloads or synchronous hot-path logging. External writes need an idempotent or disposable target. Remove unsupported experimental edits.

## Follow a request across the stack

Trace IDs and span IDs join a slow interaction to server, queue or dependency; request IDs join logs without spans. Retries may share a trace ID: find the attempt that delayed completion. A parent span includes its children and parallel children overlap, so summed spans can exceed the request latency. A hot stack shared by concurrent requests shows process activity, not per-request cost: that needs a task/span link or an isolated replay. Cross-host timestamp subtraction needs aligned clocks; local durations and causal links stay valid.

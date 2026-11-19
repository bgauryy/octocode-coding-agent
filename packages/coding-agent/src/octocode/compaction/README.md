# compaction/

Two kinds of code live here.

**Compaction** writes and restores summaries: `summary*.ts`, `restore*.ts`, `early-summary.ts`, `archive*`, `pacing.ts`.

**Request projection** runs on _every_ model request, not only after a compaction. `register.ts` installs a `context`
handler that calls `requestView` (`request-view.ts`), which returns copies of the messages with:

- untrusted results fenced as data (`untrusted-results.ts`, `fenceUntrustedResults`);
- cleared results replaced by their placeholders (`clearing.ts`);
- thinking that a summary or a cleared result made stale dropped (`thinking.ts`, `requestMessages`).

`requestMessages` in `thinking.ts` is the single projection entry point; the cache-sharing summary request builds its
messages through the same function. When asking "is this tool result fenced on a live request?", read these files.

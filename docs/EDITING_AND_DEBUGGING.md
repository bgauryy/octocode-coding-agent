# Editing, feedback, verification, and debugging

Native sessions read source with Octocode research tools, mutate it with `file`, run checks with `bash`, and optionally inspect a stopped process with `debug`. The [native feature guide](../packages/coding-agent/docs/native-features.md#tool-selection-and-migration) owns tool selection and read-command rules; [configuration](../CONFIGURATIONS.md) owns settings. See the canonical [debugger guide](../packages/coding-agent/docs/debugging.md) for adapter setup and action arguments.

## Edit and verify

```mermaid
flowchart TD
  A["Local source read"] --> B["Read receipt and coverage"]
  B --> C["file review and guard"]
  C -->|"refused or stale"| A
  C -->|"approved"| D["Queued atomic commit"]
  D --> E["Commit receipt and advisory feedback"]
  E -->|"pending or unavailable"| F["Inspect or rerun"]
  E --> G["bash verify receipt"]
  F --> G
```

Read a known file with `localFetch` (or unminified `localGetFileContent` on an older server). The [read receipt](../packages/coding-agent/src/octocode/files/read-receipts.ts) credits unchanged source windows. Only a complete, untransformed read visible to the model supplies a copyable whole-source SHA-256. Partial, cut, failed, filtered and nested reads cannot supply an anchor. With local readers unavailable, the [native guide](../packages/coding-agent/docs/native-features.md#tool-selection-and-migration) lists the literal `bash` printers that count as reads. Repeat a read if its result has left the current context.

An ordinary `file` edit replaces exact `oldText` with `newText`. An optional complete-line anchor uses `edits: [{ line, sourceSha256, oldText, newText }]`: `line` is one-based, and `oldText` is the whole line without its terminator. The [anchor adapter](../packages/coding-agent/src/octocode/files/tool/anchored.ts) checks the visible source digest and current bytes, then finds unique context within 128 lines. It refuses stale, ambiguous or partial identity instead of guessing. The [file tool](../packages/coding-agent/src/octocode/files/tool.ts) also reviews permission, workspace and later-session paths, reservations, read coverage and target identity before [execution](../packages/coding-agent/src/octocode/files/tool/run.ts) checks the bytes again under a per-file queue and cross-process lock. External writers that ignore the lock can still race it.

A committed write or deletion gets a receipt even when later cleanup fails. A query batch reports each outcome and may continue after a failure; a patch validates first and stops on execution failure. Earlier commits remain: there is **no multi-file transaction**. Post-batch [parser](../packages/coding-agent/src/octocode/files/feedback/parse.ts) and [LSP diagnostic](../packages/coding-agent/src/octocode/files/feedback/diagnostics.ts) calls inspect a bounded set of targets with cancellation and deadlines. Unavailable, unpublished, timed-out and superseded feedback is not clean evidence. The nested call receives the abort signal, but a timed-out observation is still reported as pending or unsupported. Parser and LSP responses do **not** attest their source version, so their conclusions remain advisory. The [environment reference](../packages/coding-agent/docs/environment-variables.md) describes the feedback switch.

Use `bash({ command: "yarn test", verify: true })` for the check that matters. Its [receipt](../packages/coding-agent/src/octocode/files/bash/verification.ts) records command, exit or signal, output availability, process epoch and native `file` mutation revisions. A background start is pending; observed completion sends a terminal follow-up, while shutdown's pre-stop report remains pending and incomplete. A zero exit describes only that command. Later native `file` commits mark the receipt stale; `stale: false` cannot detect shell writes, debugger effects, editors or other processes. Inspect or rerun after those changes.

## Optional debugger

```mermaid
stateDiagram-v2
  [*] --> Starting: launch
  Starting --> Running: initialized and configured
  Starting --> Stopped: stop during configuration
  Starting --> Ended: abort, timeout or close
  Running --> Stopped: stop event
  Stopped --> Running: continue or step
  Running --> Ended: terminate or close
  Stopped --> Ended: terminate or close
  Ended --> [*]
```

Enable `debug` explicitly with `octocode --tools +debug` and supply an installed stdio DAP adapter. The [host tool](../packages/coding-agent/src/octocode/debug/tool.ts) routes launch, inspection and stepping through process permission; `terminate` is exempt. Read-only and isolated child roles refuse debugging. Launch reports breakpoint verification and a stop generation. At a stop, inspect stack, scopes and variables using returned IDs; continuing invalidates those IDs, so use the next generation. The [session](../packages/coding-agent/src/octocode/debug/session.ts) and [protocol](../packages/coding-agent/src/octocode/debug/protocol.ts) bound requests and output, reject stale handles and reverse requests, and close the owned adapter on termination, abort or teardown. A terminated session permits a new launch. Adapter installation, attach, evaluation, memory writes and custom requests are unsupported. Rerun the original check after fixing a debugged failure.

Generations are scoped to one adapter session: discard all handles after relaunch, even if a number repeats. Breakpoint responses do not attest that source bytes match the compiled target. Launch failures retain their original error when configuration also fails; successful launch may still wait for configuration to finish. [Validation](FEATURE_VALIDATION.md) separates fixture coverage from the incomplete live LLDB workflow.

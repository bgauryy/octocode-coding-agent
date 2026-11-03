# @octocodeai/octocode-acp (private workspace)

This workspace owns Octocode's inbound and outbound Agent Client Protocol v1 integration. It uses the official `@agentclientprotocol/sdk` **2.0.2** stable v1 API; it does not implement a second wire protocol or agent loop.

| Owner                   | Responsibility                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/server/`           | Stdio broker, session lifecycle, input and event conversion, history replay, startup cancellation, and client MCP handoff  |
| `src/client/`           | Outbound ACP process connection, permission callbacks, cancellation, bounded output and credential redaction               |
| `src/host.ts`           | The `AcpServerHost` and `AcpClientHost` ports and the worker, event and transcript types acp reads from its host           |
| `packages/coding-agent` | CLI selection, RPC workers, model execution, native permissions, persistence, external-agent manager and local session API |
| `packages/mcp`          | MCP configuration, connections and tool registration used by the inbound handoff                                           |

The private workspace and coding-agent form one compilation unit, following the repository's source-workspace convention. `octocodeSource` declares the `acp` mount; coding-agent imports these sources by relative path, so `scripts/build-coding-agent.mjs` bundles them into coding-agent's one bundle file.

Coding-agent declares this workspace as a development dependency and ships its runtime dependencies, including the ACP SDK. The workspace is **not independently publishable or installable**, but its source imports nothing from `packages/coding-agent`: everything it needs from the host arrives through the ports below. Pure helpers it shares live in `packages/common` (`cutText`, `untilAborted`, `PRIVATE_FILE_MODE`, `ACP_WORKER_ENV`) and the external-agent protocol types in `packages/contracts/src/external.ts`.

## Host ports

`src/host.ts` defines what acp needs from its host. Hosts pass an implementation explicitly; there is no global registry.

- `AcpServerHost` provides the agent directory and Node runtime, session directory configuration (`sessionDirEnv`, `configuredSessionDir`), session listing and transcripts for history replay, worker creation (`createWorker`, which wraps the RPC client), stdout take-over, the compaction summary text and the reported version. `coding-agent/src/main/acp-host.ts` exports the implementation (`acpServerHost`), and `main.ts` starts `--mode acp` through `runAcpMain` in that module, which calls `runAcpMode(acpServerHost, acpWorkerArguments(args, parsed))`.
- `AcpClientHost` provides `saveOutput` for bounded output archives and `processTree` (`graceMs`, `prepare`, `adopt`, `stop`) for peer process ownership. `coding-agent/src/octocode/external/acp-host.ts` exports `acpClientHost` and `connectAcp`, and `external/manager.ts` uses `connectAcp` as its default connection factory.
- `AcpBrokerHost` is the subset of `AcpServerHost` that the broker and history replay read.

Tests build the broker, backend and output objects through the real adapters: `AcpBroker({ host: acpServerHost, ... })`, `AcpBackend.connect(acpClientHost, ...)` and `new AcpOutput(acpClientHost.saveOutput)`.

## Entry points

Internal workspace exports are `@octocodeai/octocode-acp/server` (`runAcpMode(host, workerArgs)`, `acpWorkerArguments`) and `@octocodeai/octocode-acp/client` (`AcpBackend`, `AcpError`, `AcpPermission`). Production host imports use relative source paths so the host compiler can relocate them into its shipped tree. There is no new public coding-agent export or executable.

Users still launch inbound ACP with `octocode --mode acp` and connect outbound peers with the native `agent` tool. The [ACP guide](../coding-agent/docs/acp.md) owns protocol capabilities, launch instructions, Codex integration, permissions and known limits. The [local session API](../coding-agent/docs/session-api.md) remains a separate protocol for already-running processes and callbacks.

## Verification

From the repository root:

```sh
yarn workspace @octocodeai/octocode-acp test
yarn node --test scripts/acp-workspace.test.mjs
yarn run check
yarn run build:offline
```

`test/server/` and `test/client/` cover the relocated broker, history, input, approvals, startup ownership, process lifecycle, output bounds and redaction. Real coding-agent CLI/RPC/API integration tests and the Python SDK, TCK and reliability runners remain in `packages/coding-agent/test/`; their commands are in the [ACP guide](../coding-agent/docs/acp.md#verify-the-transports).

The package ownership test rejects a second source owner or a private runtime dependency and verifies staging of the inbound entry point, outbound manager and MCP handoff. Installed-package smoke tests import both shipped ACP entry points. See [dated validation](../../docs/FEATURE_VALIDATION.md) for actual run results and unverified platforms.

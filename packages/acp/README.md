# @octocodeai/octocode-acp (private workspace)

This workspace owns Octocode's inbound and outbound Agent Client Protocol v1 integration. It uses the official `@agentclientprotocol/sdk` **2.0.2** stable v1 API; it does not implement a second wire protocol or agent loop.

| Owner                   | Responsibility                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/server/`           | Stdio broker, session lifecycle, input and event conversion, history replay, startup cancellation, and client MCP handoff  |
| `src/client/`           | Outbound ACP process connection, permission callbacks, cancellation, bounded output and credential redaction               |
| `packages/coding-agent` | CLI selection, RPC workers, model execution, native permissions, persistence, external-agent manager and local session API |
| `packages/mcp`          | MCP configuration, connections and tool registration used by the inbound handoff                                           |

The private workspace and coding-agent form one compilation unit, following the repository's source-workspace convention. `octocodeSource` declares the `acp` mount; `scripts/build-host-sources.mjs` stages these sources under the host, rewrites relative imports, and compiles them into coding-agent's `dist/acp/`. Source maps point back to the original files. Bundled entry points include the same implementation.

Coding-agent declares this workspace as a development dependency and ships its runtime dependencies, including the ACP SDK. The workspace is **not independently publishable or installable**: it uses coding-agent services and types. Separating it into a standalone SDK would require explicit host interfaces for workers, history, configuration, process ownership and output archives. This extraction preserves those existing owners rather than copying them.

## Entry points

Internal workspace exports are `@octocodeai/octocode-acp/server` (`runAcpMode`, `acpWorkerArguments`) and `@octocodeai/octocode-acp/client` (`AcpBackend`, `AcpError`, `AcpPermission`). Production host imports use relative source paths so the host compiler can relocate them into its shipped tree. There is no new public coding-agent export or executable.

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

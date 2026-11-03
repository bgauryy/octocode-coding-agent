# @octocodeai/octocode-mcp (private workspace)

This private workspace owns the MCP protocol client, transports, configuration, registry, lifecycle, tools, authentication and Octocode default presets. The client lives in `src/client/`; the host integration lives beside it, with the default presets in `src/presets/octocode/` (research) and `src/presets/browser/` (the `@octocodeai/octocode-chrome-devtools` browser server).

The protocol client can run without an agent session and uses the official `@modelcontextprotocol/client` SDK. The host integration uses coding-agent services for UI, permissions and configuration. These two workspaces form one compilation unit: coding-agent declares this workspace as a development dependency, and `scripts/build-coding-agent.mjs` bundles its sources into coding-agent's one bundle file, behind the `/mcp` exports. The MCP SDK license ships with the host.

The workspace is not published or installed as a runtime dependency. Public consumers continue to import `@octocodeai/octocodecode/mcp`, `/mcp/oauth` and `/mcp/testing`. Internal workspace exports resolve directly to source.

The package provides a transport-neutral client core, stdio and Streamable HTTP transports, and an in-memory testing transport.

The official SDK owns JSON-RPC validation, serialization, handshake, dispatch and Streamable HTTP framing. The stdio adapter retains host process supervision so environment isolation, bounded output and whole-process-group cleanup continue to work. HTTP wrappers enforce redirect and credential boundaries, body limits and cancellation. Legacy SSE configuration (`type: "sse"`) is rejected; use a Streamable HTTP endpoint.

The low-level client does not discover the coding agent's `mcp.json` files or implement its `/mcp` manager. Those belong to the host integration. See [CONFIGURATIONS.md](../../CONFIGURATIONS.md) for global/workspace locations and the [MCP guide](../coding-agent/docs/mcp.md) for enable/disable, tool inspection, exposure, authentication and caching.

The host declares every tool of a selected server up front: each server's generated TypeScript file (`src/compact/`, `src/presentation/`) goes in its own cached prompt section, and provider declarations are thin stubs validated against the server's schema. `hidden` and per-tool settings withdraw tools; a server with `defaultActive: false` reaches only the agents whose tool selection names it, which is how the `browser` preset reaches only the browser subagent. The Octocode preset declares its whole catalog and ships description overrides (`src/presets/octocode/compact-overrides.json`; the browser preset has its own).

### Preset overrides and the generate:compact command

Each override is keyed on the upstream text it replaces: the server text on the hash of the instructions, a tool's description and trigger on the hash of its description, and every field on the hash of its description at a stable dotted path (`queries.limit`; array items and union variants are transparent). The hash covers that text only, so a rebuild of the server that reformats the schema, reorders fields, adds `$defs` or documents other fields leaves every override in force. An override whose upstream text changed, or whose tool or field is gone, is dropped for that field alone and the server's own text shows; `presetStatus` names it as `<tool>.<field>`, and the drift tests (`test/mcp-octocode-override-drift.test.ts`, `test/mcp-browser-override-drift.test.ts`) fail with that list.

After the linked sibling `octocode-mcp` or the browser server is rebuilt, run one command:

```sh
yarn workspace @octocodeai/octocode-mcp run generate:compact [--accept <tool.field>]... [--accept-all] [--check]
```

It reads the catalogs the servers send (an empty home, with and without a classification key, as the drift tests read them), refreshes the Octocode catalog fixtures in `test/fixtures/compact/`, and prints each stale override with its upstream text before (from the previous fixtures) and after. Read each one. If the override is still true, `--accept <tool.field>` re-points its hash; if the upstream meaning changed, edit its `text` in the JSON first, then accept it. `--accept-all` re-points every stale override and drops those whose field is gone; `--check` changes no file. The command exits 1 while an override stays stale. Then run `yarn run generate:prompts` in `packages/coding-agent`, which rewrites the rendered agent contexts, and check that `rendered/README.md` shows the `mcps` size and that the e2e prompt-size ceiling holds. Authoring new override text still goes through the `octocode-context-optimization` skill and `octocode mcp compact preset`, which prints the per-field form.

## Usage

```typescript
import { McpClient, StdioTransport } from "@octocodeai/octocodecode/mcp";

const transport = new StdioTransport({
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
});
const client = new McpClient({
	name: "my-client",
	version: "1.0.0",
	roots: [{ uri: "file:///workspace", name: "workspace" }],
});

await client.connect(transport);
const tools = await client.listTools();
const result = await client.callTool("search", { query: "MCP" });
await client.close();
```

For a remote server, use `new StreamableHttpTransport({ url, headers })`. Fetch can be injected for proxying or custom networking.

### Tools for an LLM

`toLlmContent(result)` converts a `CallToolResult` to text and image content for a model, in the shape of `@octocodeai/octocode-ai`'s `TextContent` and `ImageContent`. Text and images pass through, and audio becomes a short text placeholder. The client discards annotations and never reads resources itself: `callTool` turns an embedded text resource into a text block (a `[resource <uri> (<mimeType>)]` line, then the text), an embedded image blob into an image block, another blob into a line naming its URI, type and size, and a resource link into its URI, name, title, description, type and size. Other unknown blocks become placeholders. A result without content blocks but with `structuredContent` becomes its JSON.

Wrapping an MCP tool as an `@octocodeai/octocode-agent-core` `AgentTool`:

```typescript
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { toLlmContent } from "@octocodeai/octocodecode/mcp";
import { Type } from "typebox";

const tools: AgentTool[] = (await client.listTools()).map((tool) => ({
	// Providers allow at most 64 characters of [A-Za-z0-9_-].
	name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
	label: tool.title ?? tool.name,
	description: tool.description ?? tool.name,
	// Providers require an object schema, and some reject one without `properties`.
	parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
	execute: async (_toolCallId, params, signal) => {
		const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
		// MCP reports tool failures in the result instead of as a protocol error.
		return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
	},
}));
```

Hosts can also forward progress and retain `structuredContent` for programmatic consumers. The Octocode server sends its JSON result only as one text block, so for its tools that declare output (its local readers always do) the preset parses that block into `structuredContent`, unless the text is longer than the result text cap. The SDK's `onProgress` callback supplies `progress`, `total` and `message`; the opaque `progressToken` remains available through `onNotification("notifications/progress", ...)`. Progress renews the idle timeout, while the host enforces a separate absolute total deadline. A nonpositive or nonfinite idle timeout maps to the platform's maximum timer delay (about 24.8 days); the default 30-minute total deadline and caller cancellation still apply.

### OAuth

`@octocodeai/octocodecode/mcp/oauth` adapts the official SDK's MCP OAuth primitives to the host's credential storage and authorization lifecycle:

```typescript
import { McpClient, StreamableHttpTransport } from "@octocodeai/octocodecode/mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	OAuthCallbackServer,
} from "@octocodeai/octocodecode/mcp/oauth";

const serverUrl = "https://mcp.example.com/mcp";
const callback = await OAuthCallbackServer.listen();
let authorizationUrl: URL | undefined;
const oauth = new McpOAuthProvider({
	serverUrl,
	redirectUrl: callback.redirectUrl,
	clientMetadata: { client_name: "My MCP client" },
	onRedirect: (url) => {
		authorizationUrl = url;
	},
});

const connect = () => {
	const client = new McpClient({ name: "my-client", version: "1.0.0" });
	return {
		client,
		connected: client.connect(new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(oauth) })),
	};
};

const first = connect();
try {
	await first.connected;
} catch (error) {
	if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
	const state = await oauth.state();
	const result = callback.waitForCallback(state);
	// Open authorizationUrl in the user's browser here.
	const { code } = await result;
	await authorizeMcp(oauth, { serverUrl, authorizationCode: code });
}

const { client, connected } = connect();
await connected;
```

`adaptOAuthProvider` is this package's own 401 policy for standalone clients: after a 403 for more scope it steps up silently through the provider's authorization flow. The Octocode host does not use it. It implements the `AuthProvider` interface itself (`src/oauth/auth-provider.ts`) and asks the user to sign in again for more scope.

Inject `McpOAuthStateStore` into `McpOAuthProvider` for durable credentials. The package does not open a browser or choose where credentials are stored.

OAuth discovery, registration, PKCE and token exchanges use the official MCP SDK. Host policy retains configured metadata overrides, cancellation, credential storage and scope-consent decisions. The historical SDK attribution and license remain under `LICENSES/`.

An MCP transport owns framing and I/O. It delivers individual JSON-RPC messages to `McpClient`; the client owns request correlation, initialization, timeouts, cancellation, server requests, and protocol-level helpers.

## Supported protocol surface

- MCP protocol version `2025-11-25`, accepting servers that negotiate `2025-06-18`, `2025-03-26`, or `2024-11-05`
- initialization and `notifications/initialized`
- ping
- paginated `tools/list`
- `tools/call`, including structured content
- progress notifications and timeout renewal
- request cancellation
- Streamable HTTP sessions, the server-to-client GET stream with reconnection, and resumption of dropped response streams with `Last-Event-ID`
- stdio shutdown per the spec (close stdin, then SIGTERM, then SIGKILL), applied to the server's whole process group
- server `ping` and `roots/list` requests
- logging and tool-list-change notifications through the generic notification API
- OAuth protected-resource and authorization-server discovery
- PKCE authorization code flow, dynamic client registration, token refresh (one refresh shared by concurrent 401s), and step-up authorization for `insufficient_scope`

The stateless `2026-07-28` protocol is not implemented. Batch JSON-RPC messages, server implementation, prompt discovery, sampling, elicitation, resources, annotations, and tasks are outside this client's supported surface. The coding-agent host's [MCP reference](../coding-agent/docs/mcp.md#host-and-protocol-support) describes its exposed features and conformance limits.

## Testing

`@octocodeai/octocodecode/mcp/testing` exports `createInMemoryTransportPair()` for client and adapter tests.

Run these commands from the repository root:

```bash
yarn workspace @octocodeai/octocode-mcp test
yarn run test:mcp-conformance
yarn run build:offline
```

The package tests cover the client and host integration; coding-agent retains its application/session integration tests. The [conformance guide](test/conformance/README.md) describes the pinned suite and known failures.

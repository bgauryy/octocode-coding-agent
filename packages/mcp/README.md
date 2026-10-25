# @octocodeai/octocode-mcp (private workspace)

This private workspace owns the MCP protocol client, transports, configuration, registry, lifecycle, tools, authentication and Octocode default preset. The client lives in `src/client/`; the host integration lives beside it, with the default preset in `src/presets/octocode/`.

The protocol client can run without an agent session and does not depend on the official MCP SDK. The host integration uses coding-agent services for UI, permissions and configuration. These two workspaces form one compilation unit: coding-agent declares this workspace as a development dependency, and `scripts/build-host-sources.mjs` compiles its sources into coding-agent's `dist/mcp/`. The temporary compilation tree is removed after each build. Source maps point to the original files and the MCP SDK license ships with the host.

The workspace is not published or installed as a runtime dependency. Public consumers continue to import `@octocodeai/octocodecode/mcp`, `/mcp/oauth` and `/mcp/testing`. Internal workspace exports resolve directly to source.

The package provides a transport-neutral client core, stdio, Streamable HTTP and legacy HTTP+SSE transports, and an in-memory testing transport.

The low-level client does not discover the coding agent's `mcp.json` files or implement its `/mcp` manager. Those belong to the host integration. See [CONFIGURATIONS.md](../../CONFIGURATIONS.md) for global/workspace locations and the [MCP guide](../coding-agent/docs/mcp.md) for enable/disable, tool inspection, exposure, authentication and caching.

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
For a server using the older HTTP+SSE transport, use `new LegacySseTransport({ url, headers })` with its SSE URL. It waits for the server's `endpoint` event before posting messages to the advertised same-origin URL. Its GET stream closes with the client; dropped streams are not replayed, and POST requests are not retried after ordinary failures. `endpointTimeoutMs` defaults to 10 seconds. The transport rejects redirects, URL credentials and cross-origin POST endpoints.

### Tools for an LLM

`toLlmContent(result)` converts a `CallToolResult` to text and image content for a model, in the shape of `@octocodeai/octocode-ai`'s `TextContent` and `ImageContent`. Text and images pass through, and audio becomes a short text placeholder. The client discards annotations and converts unsupported blocks, including resources and resource links, to placeholders without reading their payloads. A result without content blocks but with `structuredContent` becomes its JSON.

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

Hosts can also forward progress and retain `structuredContent` for programmatic consumers.

### OAuth

`@octocodeai/octocodecode/mcp/oauth` provides the MCP OAuth client subset without depending on the official SDK:

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
		connected: client.connect(
			new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(oauth) }),
		),
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

The OAuth implementation is adapted from the MIT-licensed Model Context Protocol TypeScript SDK v1.29.0. Its license is included under `LICENSES/`.

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
- Legacy HTTP+SSE sessions with one GET stream and a same-origin POST endpoint supplied by the server
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

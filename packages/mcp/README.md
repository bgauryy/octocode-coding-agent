# @octocodeai/octocode-mcp (private workspace)

Contributor README. For using MCP servers in Octocode see the [MCP guide](../coding-agent/docs/mcp.md).

This private workspace owns the MCP protocol client, transports, configuration, registry, lifecycle, tools, authentication and default servers. The client lives in `src/client/`; the host integration lives beside it, with the recommended default servers as data in `src/recommended/` (research) and the preset in `src/presets/browser/` (the `@octocodeai/octocode-chrome-devtools` browser server).

The protocol client can run without an agent session and uses the official `@modelcontextprotocol/client` SDK. The host integration uses coding-agent services for UI, permissions and configuration. These two workspaces form one compilation unit: coding-agent declares this workspace as a development dependency, and `scripts/build/build-coding-agent.mjs` bundles its sources into coding-agent's one bundle file, behind the `/mcp` exports. The MCP SDK license ships with the host.

The workspace is not published or installed as a runtime dependency. Public consumers continue to import `@octocodeai/octocode-agent/mcp` and `/mcp/oauth`; the testing helpers do not ship. Internal workspace exports resolve directly to source.

coding-agent imports this workspace only through `src/api.ts`; a host file that needs another name adds it there. Other workspaces import the package `exports` by name. `yarn run check:mcp-boundary` fails on any other import into `src/` from outside it (tests may import private modules).

The package provides a transport-neutral client core, stdio and Streamable HTTP transports, and an in-memory testing transport.

The official SDK owns JSON-RPC validation, serialization, handshake, dispatch and Streamable HTTP framing. The stdio adapter retains host process supervision so environment isolation, bounded output and whole-process-group cleanup continue to work. HTTP wrappers enforce redirect and credential boundaries, body limits and cancellation. Legacy SSE configuration (`type: "sse"`) is rejected; use a Streamable HTTP endpoint.

The low-level client does not discover the coding agent's `mcp.json` files or implement its `/mcp` manager. Those belong to the host integration. See [configuration](../coding-agent/docs/configuration.md#where-each-configuration-belongs) for global/workspace locations and the [MCP guide](../coding-agent/docs/mcp.md) for enable/disable, tool inspection, exposure, authentication and caching.

How tools reach the model (`declared`, `compact`, `json`), exposure and assignment are documented for users in the [MCP guide](../coding-agent/docs/mcp.md) and [MCP reference](../coding-agent/docs/mcp-reference.md#presentation-modes). The model reads each server's own text; descriptions, schemas and instructions are never rewritten.

## Usage

```typescript
import { McpClient, StdioTransport } from "@octocodeai/octocode-agent/mcp";

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
import { toLlmContent } from "@octocodeai/octocode-agent/mcp";
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

Hosts can also forward progress and retain `structuredContent` for programmatic consumers. The research preset parses the server's single JSON text block into `structuredContent` for tools that declare output, unless the text exceeds the result text cap. The SDK's `onProgress` callback supplies `progress`, `total` and `message`; the opaque `progressToken` remains available through `onNotification("notifications/progress", ...)`. Progress renews the idle timeout only for a request made with `onProgress` (without it no `progressToken` is sent), while the host enforces a separate absolute total deadline. A response or progress notification that arrives after the request was cancelled or timed out is ignored, not reported to `onError`. In Octocode, an MCP tool's progress reaches views as a partial update with `progress` (`progress`, `total`, `message`; see `ApplicationToolProgress` in the contracts), and hook calls through `events.callTool` send a token too. A nonpositive or nonfinite idle timeout maps to the platform's maximum timer delay (about 24.8 days); the default 30-minute total deadline and caller cancellation still apply.

### OAuth

`@octocodeai/octocode-agent/mcp/oauth` adapts the official SDK's MCP OAuth primitives to the host's credential storage and authorization lifecycle:

```typescript
import { McpClient, StreamableHttpTransport } from "@octocodeai/octocode-agent/mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	OAuthCallbackServer,
} from "@octocodeai/octocode-agent/mcp/oauth";

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
- paginated `resources/list` and `resources/templates/list`, and `resources/read`, when the server declares `resources`
- paginated `prompts/list` and `prompts/get`, when the server declares `prompts`
- OAuth protected-resource and authorization-server discovery
- PKCE authorization code flow, dynamic client registration, token refresh (one refresh shared by concurrent 401s), and step-up authorization for `insufficient_scope`

The stateless `2026-07-28` protocol is not implemented. Batch JSON-RPC messages, server implementation, resource subscriptions, sampling, elicitation, annotations, and tasks are outside this client's supported surface. The coding-agent host's [MCP reference](../coding-agent/docs/mcp.md#host-and-protocol-support) describes its exposed features and conformance limits.

## Testing

`src/client/testing/index.ts` exports `createInMemoryTransportPair()` for this repository's client and adapter tests. It is not part of the published package.

Run these commands from the repository root:

```bash
yarn workspace @octocodeai/octocode-mcp test
yarn run test:mcp-conformance
yarn run build:offline
```

The package tests cover the client and host integration; coding-agent retains its application/session integration tests. The [conformance guide](test/conformance/README.md) describes the pinned suite and known failures.

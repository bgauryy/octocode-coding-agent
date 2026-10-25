/**
 * OAuth sign-in for remote MCP servers.
 *
 * Connections never start a browser flow on their own. They send the stored access token and, after
 * a 401, try the stored refresh token. When that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and the user signs in through `/mcp`, which runs
 * the authorization code flow (PKCE, a Client ID Metadata Document or dynamic client registration)
 * against a loopback callback.
 *
 * Credentials live in `<agent-dir>/mcp-auth.json`, keyed by server name and URL.
 */

export { createMcpAuthProvider, type McpAuthProvider } from "./oauth/auth-provider.ts";
export { McpOAuthCredentialStore } from "./oauth/credential-store.ts";
export type { McpOAuthSettings } from "./oauth/shared.ts";
export { McpSignInCancelledError, type McpSignInPrompt, signInMcpServer } from "./oauth/sign-in.ts";

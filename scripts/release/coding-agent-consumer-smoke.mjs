// Copied into the installed package so every import resolves as it does for its consumers.
import assert from "node:assert/strict";

const [packageName, mcpExecutable, ...expectedTools] = process.argv.slice(2);
const { RpcClient, runRpcMode, runPrintMode, main } = await import(packageName);
const { McpClient, StdioTransport } = await import(`${packageName}/mcp`);
const { McpOAuthProvider } = await import(`${packageName}/mcp/oauth`);
for (const entry of [RpcClient, runRpcMode, runPrintMode, main, McpClient, StdioTransport, McpOAuthProvider]) {
	assert.equal(typeof entry, "function");
}

if (mcpExecutable) {
	const client = new McpClient({ name: "package-check", version: "1", requestTimeoutMs: 15_000 });
	try {
		await client.connect(
			new StdioTransport({
				command: process.execPath,
				args: [mcpExecutable],
				cwd: process.env.HOME,
				env: {
					OCTOCODE_HOME: process.env.HOME,
					WORKSPACE_ROOT: process.env.HOME,
					OCTOCODE_ENABLE_CLONE: "true",
					OCTOCODE_SECURITY_CHECKS: "true",
				},
			}),
		);
		const tools = new Set((await client.listTools()).map((tool) => tool.name));
		const missing = expectedTools.filter((tool) => !tools.has(tool));
		assert.equal(missing.length, 0, `Installed research server is missing preset tools: ${missing.join(", ")}`);
	} finally {
		await client.close();
	}
}

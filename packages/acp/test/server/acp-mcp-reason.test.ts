import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../../coding-agent/src/core/resource-loader.ts";
import { createHarness } from "../../../coding-agent/test/suite/harness.ts";
import { MCP_MANAGE_TOOL_NAME } from "../../../mcp/src/servers.ts";
import { prepareAcpMcpServers } from "../../src/server/mcp.ts";

type Schema = { required?: string[]; properties?: Record<string, { type?: string }> };

/**
 * An ACP worker is an ordinary native session (`octocode --mode rpc` with the ACP flag), so its `mcp` tool comes from
 * the built-in MCP extension. The client's MCP servers arrive as one more extension that registers servers only.
 */
describe("the mcp tool of an ACP worker session", () => {
	let root: string;
	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "acp-mcp-reason-")));
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", join(root, "agent"));
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	it("requires the call reason, with or without client MCP servers", async () => {
		const clientServers = await prepareAcpMcpServers(
			[{ name: "client server", command: process.execPath, args: [], env: [] }],
			root,
		);
		try {
			for (const additionalExtensionPaths of [[], [clientServers.args[1]]]) {
				const loader = new DefaultResourceLoader({
					cwd: root,
					agentDir: join(root, "agent"),
					additionalExtensionPaths,
				});
				await loader.reload();
				const harness = await createHarness({ resourceLoader: loader });
				try {
					await harness.session.bindExtensions({});
					const tool = harness.session.getToolDefinition(MCP_MANAGE_TOOL_NAME);
					expect(tool).toBeDefined();
					const schema = tool!.parameters as Schema;
					expect(schema.required).toContain("reason");
					expect(schema.properties?.reason?.type).toBe("string");
				} finally {
					harness.cleanup();
				}
			}
		} finally {
			await clientServers.cleanup();
		}
	});
});

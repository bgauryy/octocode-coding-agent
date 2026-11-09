import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACP_MCP_MANIFEST_ENV, ACP_WORKER_ENV } from "../../../common/src/env.ts";
import { DefaultResourceLoader } from "../../../coding-agent/src/core/resource-loader.ts";
import { createHarness } from "../../../coding-agent/test/suite/harness.ts";
import { MCP_MANAGE_TOOL_NAME } from "../../../common/src/mcp-names.ts";
import { acpServerHost } from "../../../coding-agent/src/main/acp-host.ts";
import { prepareAcpMcpServers } from "../../src/server/mcp.ts";

type Schema = { required?: string[]; properties?: Record<string, { type?: string }> };

/**
 * An ACP worker is an ordinary native session (`octocode --mode rpc` with the ACP flag), so its `mcp` tool comes from
 * the built-in MCP feature. The client's MCP servers reach that feature through the broker's manifest environment.
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
			acpServerHost,
		);
		try {
			for (const withClientServers of [false, true]) {
				if (withClientServers) {
					vi.stubEnv(ACP_WORKER_ENV, "1");
					vi.stubEnv(ACP_MCP_MANIFEST_ENV, clientServers.env[ACP_MCP_MANIFEST_ENV]);
				}
				const loader = new DefaultResourceLoader({
					cwd: root,
					agentDir: join(root, "agent"),
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

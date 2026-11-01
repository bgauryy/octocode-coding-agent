import "../mcp-host.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Launch from "../../../mcp/src/presets/octocode/launch.ts";

const launches: Array<{ trusted: unknown; skills: unknown }> = [];
vi.mock("../../../mcp/src/presets/octocode/launch.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Launch>()),
	octocodeLaunch: (cwd: string, _env: unknown, _entry: unknown, skills: unknown, trusted: unknown) => {
		launches.push({ trusted, skills });
		return { command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], cwd, env: {} };
	},
}));

const { mcpHost } = await import("../../../mcp/test/mcp-host-fixture.ts");
const { fakeCtx } = await import("./fake-host.ts");
const { tmp } = await import("./helpers.ts");

afterEach(() => {
	launches.length = 0;
});

describe("built-in Octocode MCP and project trust", () => {
	it.each([true, false])("launches with the session's project trust (%s)", async (trusted) => {
		const ctx = { ...fakeCtx({ cwd: tmp(), hasUI: false }), isProjectTrusted: () => trusted };
		const mcp = mcpHost({ startupWaitMs: 1 });
		await mcp.start(ctx);
		await mcp.prompt(ctx);
		await vi.waitFor(() => expect(launches.at(-1)?.trusted).toBe(trusted));
		await mcp.close();
	});
});

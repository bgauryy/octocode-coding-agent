import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Launch from "../../src/octocode/mcp/octocode/launch.ts";

const launches: Array<{ trusted: unknown; skills: unknown }> = [];
vi.mock("../../src/octocode/mcp/octocode/launch.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Launch>()),
	octocodeLaunch: (cwd: string, _env: unknown, _entry: unknown, skills: unknown, trusted: unknown) => {
		launches.push({ trusted, skills });
		return { command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], cwd, env: {} };
	},
}));

const { OctocodeMcp } = await import("../../src/octocode/mcp/octocode.ts");
const { fakeCtx, fakePi } = await import("./fake-pi.ts");
const { tmp } = await import("./helpers.ts");

afterEach(() => {
	launches.length = 0;
});

describe("built-in Octocode MCP and project trust", () => {
	it.each([true, false])("launches with the session's project trust (%s)", async (trusted) => {
		const ctx = { ...fakeCtx({ cwd: tmp(), hasUI: false }), isProjectTrusted: () => trusted };
		const mcp = new OctocodeMcp(fakePi().pi, { env: {}, connectWaitMs: 1 });
		await mcp.start(ctx);
		expect(launches.at(-1)?.trusted).toBe(trusted);
		await mcp.close();
	});
});

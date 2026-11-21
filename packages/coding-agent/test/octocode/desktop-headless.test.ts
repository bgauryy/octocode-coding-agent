import "../mcp-host.ts";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { loadSessionProfiles } from "../../src/octocode/subagents/session-profiles.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A PATH that holds an executable `cua-driver`, so the desktop specialist is available as on a machine with Cua installed. */
function withCuaOnPath(): void {
	const folder = tmp();
	mkdirSync(folder, { recursive: true });
	const file = join(folder, "cua-driver");
	writeFileSync(file, "#!/bin/sh\n");
	chmodSync(file, 0o755);
	process.env.PATH = `${folder}:${saved.PATH ?? ""}`;
	process.env.OCTOCODE_MCP_DESKTOP = "1";
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const key of ["PATH", "OCTOCODE_MCP_DESKTOP"]) saved[key] = process.env[key];
});
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const profilesFor = (hasUI: boolean, isSubagent: boolean) => {
	const { api } = fakeHost();
	return loadSessionProfiles(api, fakeCtx({ cwd: tmp(), hasUI }), isSubagent).profiles;
};

describe("the desktop specialist needs someone to approve its start", () => {
	it("is offered to a session a person or a client answers, when Cua Driver is installed", () => {
		withCuaOnPath();
		expect(profilesFor(true, false).has("desktop")).toBe(true);
	});

	it("is not offered to a main session nobody can ask (print and JSON runs)", () => {
		withCuaOnPath();
		expect(profilesFor(false, false).has("desktop")).toBe(false);
	});

	it("stays defined for its own child, which runs with its parent's answer", () => {
		withCuaOnPath();
		expect(profilesFor(false, true).has("desktop")).toBe(true);
	});

	it("is not offered when the user switched the desktop server off in their configuration", () => {
		withCuaOnPath();
		const file = join(getAgentDir(), "mcp.json");
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(file, JSON.stringify({ mcpServers: { desktop: { enabled: false } } }));
		try {
			expect(profilesFor(true, false).has("desktop")).toBe(false);
		} finally {
			rmSync(file, { force: true });
		}
		expect(profilesFor(true, false).has("desktop")).toBe(true);
	});

	it("is not offered without Cua Driver, whoever asks", () => {
		process.env.OCTOCODE_MCP_DESKTOP = "0";
		expect(profilesFor(true, false).has("desktop")).toBe(false);
	});
});

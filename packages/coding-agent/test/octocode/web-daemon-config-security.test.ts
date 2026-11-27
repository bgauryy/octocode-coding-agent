import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecurityListSchema, type SecurityList } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { resetGateRecords } from "../../src/octocode/guard/registry.ts";
import { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";
import { actSecurity, listSecurity, type SecurityOptions } from "../../src/octocode/web-daemon/security-config.ts";

let root: string;
let options: SecurityOptions;
let mcpFile: string;

const server = (args: string[]) =>
	fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { weather: { command: "npx", args } } }));
const weather = (list: SecurityList) => list.items.find((entry) => entry.id === "mcp:weather");

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-security-")));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".octocode", "octocodecode");
	fs.mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
	mcpFile = path.join(agentDir, "mcp.json");
	server(["-y", "weather-mcp@1.0.0"]);
	// The first sight of a kind imports global items as approved; the guard already saw MCP here.
	options = {
		agentDir,
		cwd: root,
		guard: { env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "agent.db") } },
	};
	resetGateRecords();
});
afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("Security panel route", () => {
	it("lists a reviewed server, and approve, deny and forget from the web change the guard store", async () => {
		const first = await listSecurity(options);
		expect(Value.Check(SecurityListSchema, first)).toBe(true);
		expect(weather(first)).toMatchObject({ kind: "mcp", state: "not checked", changed: false, scope: "global" });

		const approved = await actSecurity("mcp:weather", "approve", options);
		expect(weather(approved)?.state).toBe("approved");
		expect(approved.message).toBeTruthy();
		// A fresh listing reads the store, not the reply.
		expect(weather(await listSecurity(options))?.state).toBe("approved");

		const denied = await actSecurity("mcp:weather", "deny", options);
		expect(weather(denied)?.state).toBe("denied");
		const forgotten = await actSecurity("mcp:weather", "forget", options);
		expect(weather(forgotten)?.state).toBe("not checked");
		expect(Value.Check(SecurityListSchema, forgotten)).toBe(true);
	});

	it("shows what changed since the approval", async () => {
		await actSecurity("mcp:weather", "approve", options);
		server(["-y", "weather-mcp@2.0.0"]);
		const changed = weather(await listSecurity(options));
		expect(changed).toMatchObject({ state: "not checked", changed: true });
		expect(changed?.changes?.join("\n")).toContain("2.0.0");
	});

	it("refuses an unknown item", async () => {
		await expect(actSecurity("mcp:nothing", "approve", options)).rejects.toBeInstanceOf(ConfigWriteError);
	});
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import type { ExtensionAPI } from "../../coding-agent/src/core/features/types.ts";
import {
	getMcpSessionHandoff,
	parseMcpSessionServers,
	registerInheritedMcpServers,
	registerMcpAddedServers,
	serializeMcpSessionServers,
} from "../src/session-servers.ts";
import { MCP_SESSION_SERVERS_FILE_ENV } from "../../common/src/env.ts";
import { subagentProcessEnv } from "../../coding-agent/src/octocode/subagents/process/env.ts";

const stdio = { command: "node", args: ["server.js"], env: { TOKEN: "t" } };

describe("session MCP servers handed to children", () => {
	it("answers requests on the event bus with the owner's current servers", () => {
		const events = createEventBus();
		expect(getMcpSessionHandoff(events).servers).toEqual({});
		const added: Record<string, typeof stdio> = { echo: stdio };
		const off = registerMcpAddedServers(events, () => ({ servers: added, stopped: [], available: [] }));
		expect(getMcpSessionHandoff(events).servers).toEqual({ echo: stdio });
		delete added.echo;
		expect(getMcpSessionHandoff(events).servers).toEqual({});
		off();
	});

	it("round-trips servers and drops invalid entries", () => {
		expect(serializeMcpSessionServers({})).toBeUndefined();
		const text = JSON.stringify({ version: 1, servers: { echo: stdio, bad: { nothing: true } } });
		const { servers, errors } = parseMcpSessionServers(text);
		expect(servers).toEqual({ echo: stdio });
		expect(errors).toHaveLength(1);
		expect(parseMcpSessionServers(serializeMcpSessionServers({ echo: stdio })!).servers).toEqual({ echo: stdio });
		expect(() => parseMcpSessionServers('{"version":4,"servers":{}}')).toThrow("not a session server list");
	});

	it("registers them only in a subagent that was given the file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-servers-"));
		const file = path.join(dir, "servers.json");
		fs.writeFileSync(file, serializeMcpSessionServers({ echo: stdio })!);
		const api = { registerMcpServer: vi.fn() } as unknown as ExtensionAPI;
		registerInheritedMcpServers(api, { [MCP_SESSION_SERVERS_FILE_ENV]: file });
		expect(api.registerMcpServer).not.toHaveBeenCalled();
		registerInheritedMcpServers(api, { OCTOCODE_SUBAGENT: "1" });
		expect(api.registerMcpServer).not.toHaveBeenCalled();
		registerInheritedMcpServers(api, { OCTOCODE_SUBAGENT: "1", [MCP_SESSION_SERVERS_FILE_ENV]: file });
		// Marked inherited, so the child's own registration of the same name replaces it.
		expect(api.registerMcpServer).toHaveBeenCalledWith("echo", stdio, { inherited: true });
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("keeps an unreadable file from failing the child", () => {
		const api = { registerMcpServer: vi.fn() } as unknown as ExtensionAPI;
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		registerInheritedMcpServers(api, { OCTOCODE_SUBAGENT: "1", [MCP_SESSION_SERVERS_FILE_ENV]: "/nonexistent/x.json" });
		expect(api.registerMcpServer).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalled();
		write.mockRestore();
	});

	it("passes the file to the child environment and drops a stale value from the parent's", () => {
		const base = { [MCP_SESSION_SERVERS_FILE_ENV]: "/stale" };
		expect(subagentProcessEnv(undefined, base)[MCP_SESSION_SERVERS_FILE_ENV]).toBeUndefined();
		expect(
			subagentProcessEnv(undefined, base, undefined, undefined, undefined, undefined, "/fresh")[
				MCP_SESSION_SERVERS_FILE_ENV
			],
		).toBe("/fresh");
	});
});

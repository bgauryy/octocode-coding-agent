import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import type { FeatureSetup } from "../../src/core/features/types.ts";
import {
	getMcpSessionHandoff,
	isParentStopped,
	parseMcpSessionServers,
	registerInheritedMcpServers,
	registerMcpAddedServers,
	serializeMcpSessionServers,
} from "../../../mcp/src/session-servers.ts";
import { MCP_SESSION_SERVERS_FILE_ENV } from "@octocodeai/octocode-common/env";

const stdio = { command: "node", args: ["server.js"] };

describe("servers the parent stopped for the session", () => {
	it("answers handoff requests with added servers and stopped names", () => {
		const events = createEventBus();
		expect(getMcpSessionHandoff(events)).toEqual({ servers: {}, stopped: [], available: [] });
		const off = registerMcpAddedServers(events, () => ({
			servers: { echo: stdio },
			stopped: ["cfg"],
			available: ["echo"],
		}));
		expect(getMcpSessionHandoff(events)).toEqual({ servers: { echo: stdio }, stopped: ["cfg"], available: ["echo"] });
		off();
	});

	it("keeps version 1 without stopped servers and reads stopped names from version 2", () => {
		expect(JSON.parse(serializeMcpSessionServers({ echo: stdio })!).version).toBe(1);
		expect(serializeMcpSessionServers({}, [])).toBeUndefined();
		const text = serializeMcpSessionServers({}, ["cfg"])!;
		expect(JSON.parse(text).version).toBe(2);
		expect(parseMcpSessionServers(text)).toEqual({ servers: {}, stopped: ["cfg"], errors: [] });
		// A version 1 file carries no stopped names, even when the field is present.
		expect(parseMcpSessionServers('{"version":1,"servers":{},"stopped":["cfg"]}').stopped).toEqual([]);
		expect(() => parseMcpSessionServers('{"version":4,"servers":{}}')).toThrow("not a session server list");
	});

	it("returns the stopped names from the file a child registers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-stopped-"));
		const file = path.join(dir, "servers.json");
		fs.writeFileSync(file, serializeMcpSessionServers({}, ["cfg"])!);
		const api = { registerMcpServer: vi.fn() } as unknown as FeatureSetup;
		expect(registerInheritedMcpServers(api, { [MCP_SESSION_SERVERS_FILE_ENV]: file })).toEqual({ stopped: [] });
		expect(registerInheritedMcpServers(api, { OCTOCODE_SUBAGENT: "1", [MCP_SESSION_SERVERS_FILE_ENV]: file })).toEqual({
			stopped: ["cfg"],
		});
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("skips a parent-stopped server unless the child's own selection names it", () => {
		const stopped = new Set(["cfg"]);
		const selects = (named: boolean) => ({
			tools: { selects: vi.fn((_prefix: string, activeByDefault: boolean) => named || activeByDefault) },
		});
		expect(isParentStopped(stopped, "other", selects(false))).toBe(false);
		// A default-active server is not named by that alone.
		expect(isParentStopped(stopped, "cfg", selects(false))).toBe(true);
		const named = selects(true);
		expect(isParentStopped(stopped, "cfg", named)).toBe(false);
		expect(named.tools.selects).toHaveBeenCalledWith("mcp__cfg__", false);
		expect(isParentStopped(stopped, "cfg", { tools: {} })).toBe(true);
	});
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachToolStates } from "@octocodeai/octocode-contracts/daemon";
import { handleSessionSettings } from "../../src/octocode/web-daemon/session-settings.ts";
import { createConfigRoutes } from "../../src/octocode/web-daemon/config-factory.ts";
import { handleConfigRequest } from "../../src/octocode/web-daemon/config-routes.ts";
import { sessionToolStates } from "../../src/octocode/web-daemon/session-tools.ts";
import { publishMcpToolStates } from "../../../mcp/src/tool-states.ts";

let root: string;
let agentDir: string;
let routes: ReturnType<typeof createConfigRoutes>["routes"];
let close: () => void;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-add-routing-"));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	vi.stubEnv("HOME", root);
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
	publishMcpToolStates(() => []);
	const config = createConfigRoutes({ env: process.env, actor: () => "test" });
	routes = config.routes;
	close = () => config.signIns.closeAll();
});
afterEach(() => {
	close();
	publishMcpToolStates(() => []);
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});
const definition = {
	name: "new",
	scope: "global",
	transport: "stdio",
	command: "never-launch",
	env: { TOKEN: "private-marker" },
};
const states = (names?: string[]): AttachToolStates => ({
	native: { names: [], deferred: {} },
	mcp: [],
	...(names === undefined ? {} : { mcpServerNames: names }),
});
async function call(
	options: {
		names?: string[];
		disconnected?: boolean;
		top?: boolean;
		body?: unknown;
		access?: "launch" | "remote" | "view";
	} = {},
) {
	const req = Readable.from(
		options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))],
	) as http.IncomingMessage;
	req.method = options.body === undefined ? "GET" : "POST";
	req.headers = { "content-type": "application/json" };
	const reply = vi.fn();
	const tools = vi.fn(async () => {
		if (options.disconnected) throw new Error("connection-private-marker");
		return states(options.names);
	});
	const url = new URL("http://localhost/api/admin/config/mcp/add");
	if (options.top)
		await handleConfigRequest(
			req,
			url,
			options.access ?? "launch",
			{ ...routes, catalog: { resolve: () => undefined } },
			reply,
		);
	else
		await handleSessionSettings(
			req,
			url,
			options.access ?? "launch",
			routes,
			{ client: { tools } },
			{ id: "session", name: "repo", root, sessions: 1 },
			reply,
		);
	return { status: reply.mock.calls[0][0], body: reply.mock.calls[0][1], tools };
}

describe("session-scoped Add MCP registry proof", () => {
	it("carries names separately from enabled tool rows without secret configuration", () => {
		const snapshot = sessionToolStates({ names: [], declared: new Map() }, [], ["disabled-ext"]);
		expect(snapshot).toEqual({ native: { names: [], deferred: {} }, mcp: [], mcpServerNames: ["disabled-ext"] });
	});
	it.each(["ext-server", "ext_server"])(
		"refuses a live disabled/registered namespace %s via the real factory",
		async (name) => {
			expect((await call({ names: ["ext-server"] })).body).toEqual({ available: true });
			const response = await call({ names: ["ext-server"], body: { ...definition, name } });
			expect(response.status).toBe(409);
			expect(fs.existsSync(path.join(agentDir, "mcp.json"))).toBe(false);
			expect(JSON.stringify(response.body)).not.toContain("private-marker");
		},
	);
	it("accepts an authoritative empty registry and persists through session forwarding", async () => {
		const response = await call({ names: [], body: definition });
		expect(response.status).toBe(200);
		expect(response.body.saved).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf8")).mcpServers.new.enabled).toBe(false);
	});
	it.each([{ top: true }, {}, { disconnected: true }])(
		"refuses unavailable or legacy registry before persistence (%j)",
		async (options) => {
			expect((await call(options)).body).toMatchObject({ available: false });
			const response = await call({ ...options, body: definition });
			expect(response.status).toBe(503);
			expect(JSON.stringify(response.body)).not.toContain("private-marker");
			expect(fs.existsSync(path.join(agentDir, "mcp.json"))).toBe(false);
		},
	);
	it("rechecks the registry at submission rather than trusting a previous availability answer", async () => {
		expect((await call({ names: [] })).body.available).toBe(true);
		expect((await call({ disconnected: true, body: definition })).status).toBe(503);
		expect((await call({ names: ["new"], body: definition })).status).toBe(409);
		expect(fs.existsSync(path.join(agentDir, "mcp.json"))).toBe(false);
	});
	it.each(["remote", "view"] as const)("denies %s status and POST before reading session metadata", async (access) => {
		for (const body of [undefined, definition]) {
			const response = await call({ names: [], access, body });
			expect(response.status).toBe(403);
			expect(response.tools).not.toHaveBeenCalled();
		}
	});
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { addWebMcp } from "../../src/octocode/web-daemon/mcp-add.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";
import { trustFolder } from "./helpers.ts";
import type { ConfigAuditEntry } from "../../../db/src/api.ts";

let root: string;
let agentDir: string;
let server: DaemonServer | undefined;
const audit = vi.fn<(entry: ConfigAuditEntry) => void>();
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-web-mcp-add-"));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	vi.stubEnv("HOME", root);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
	audit.mockClear();
});
afterEach(async () => {
	await server?.close();
	server = undefined;
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});
const definition = {
	name: "remote",
	scope: "global",
	transport: "http",
	url: "https://example.test/mcp",
	headers: { Authorization: "private-marker" },
} as const;
const options = () => ({ agentDir, actor: "web:test", audit, mcpServerNames: () => [] as string[] });
const file = () => path.join(agentDir, "mcp.json");
const readSaved = () => JSON.parse(fs.readFileSync(file(), "utf8"));

describe("web MCP persistence", () => {
	it.each(["ext-server", "ext_server"])("refuses registered namespace %s without writing", (name) => {
		expect(() => addWebMcp({ ...definition, name }, { ...options(), mcpServerNames: () => ["ext-server"] })).toThrow(
			/already exists/,
		);
		expect(fs.existsSync(file())).toBe(false);
	});
	it("refuses unavailable registration state instead of treating it as empty", () => {
		expect(() => addWebMcp(definition, { ...options(), mcpServerNames: () => undefined })).toThrow(/running session/);
		expect(fs.existsSync(file())).toBe(false);
	});
	it("reports committed save with a fixed warning when audit recording throws", () => {
		const brokenAudit = vi.fn(() => {
			throw new Error("audit-private-marker");
		});
		const result = addWebMcp(definition, { ...options(), audit: brokenAudit });
		expect(result.saved).toBe(true);
		expect(result).toHaveProperty("warnings", expect.arrayContaining([expect.any(String)]));
		expect(JSON.stringify(result)).not.toContain("private-marker");
		expect(readSaved().mcpServers.remote.headers).toEqual(definition.headers);
		expect(brokenAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ok" }));
	});
	it("keeps failed-save outcome truthful when failure auditing also throws", () => {
		addWebMcp(definition, options());
		const before = fs.readFileSync(file(), "utf8");
		const brokenAudit = vi.fn(() => {
			throw new Error("audit-private-marker");
		});
		expect(() => addWebMcp(definition, { ...options(), audit: brokenAudit })).toThrow(/already exists/);
		expect(() => addWebMcp(definition, { ...options(), audit: brokenAudit })).toThrow(/audit/i);
		expect(fs.readFileSync(file(), "utf8")).toBe(before);
		expect(brokenAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
	});
	it("keeps secrets write-only in result and audit and preserves existing settings", () => {
		const settings = path.join(agentDir, "settings.json");
		fs.writeFileSync(settings, '{"toggles":{"mcp:other":true}}');
		const result = addWebMcp(definition, options());
		expect(result.saved).toBe(true);
		expect(JSON.stringify([result, audit.mock.calls])).not.toContain("private-marker");
		expect(JSON.parse(fs.readFileSync(file(), "utf8")).mcpServers.remote).toMatchObject({
			enabled: false,
			defaultActive: false,
			headers: definition.headers,
		});
		expect(fs.readFileSync(settings, "utf8")).toBe('{"toggles":{"mcp:other":true}}');
	});
	it("refuses missing and untrusted workspace without writing", () => {
		expect(() => addWebMcp({ ...definition, scope: "workspace" }, options())).toThrow(/Choose a workspace/);
		const cwd = path.join(root, "untrusted");
		fs.mkdirSync(cwd);
		expect(() => addWebMcp({ ...definition, scope: "workspace" }, { ...options(), cwd })).toThrow(
			/Trust this workspace/,
		);
		expect(fs.existsSync(file())).toBe(false);
	});
	it("saves a trusted workspace definition and refuses existing built-in names", () => {
		const cwd = path.join(root, "trusted");
		fs.mkdirSync(cwd);
		trustFolder(cwd);
		addWebMcp({ ...definition, scope: "workspace" }, { ...options(), cwd });
		expect(JSON.parse(fs.readFileSync(path.join(cwd, ".octocode", "mcp.json"), "utf8")).mcpServers.remote.enabled).toBe(
			false,
		);
		expect(() => addWebMcp({ ...definition, name: "browser" }, options())).toThrow(/already exists/);
		expect(fs.existsSync(file())).toBe(false);
	});
	it("rejects duplicates and invalid URLs with no raw secret diagnostics", () => {
		addWebMcp(definition, options());
		const before = fs.readFileSync(file(), "utf8");
		for (const command of [definition, { ...definition, name: "invalid", url: "private-marker" }]) {
			try {
				addWebMcp(command, options());
				throw new Error("unexpected save");
			} catch (error) {
				expect(String(error)).not.toContain("private-marker");
				expect(String(error)).not.toContain("unexpected save");
			}
		}
		expect(fs.readFileSync(file(), "utf8")).toBe(before);
	});
});

describe("authorized MCP add HTTP route", () => {
	async function start(auditOverride = audit) {
		const { env } = isolatedEnv();
		const addMcp = vi.fn(async (command) => addWebMcp(command, { ...options(), audit: auditOverride }));
		server = await startDaemonServer({
			env,
			onActivity: () => {},
			onDrain: () => {},
			config: async () => ({}),
			addMcp,
		});
		const call = (token: string, body: unknown = definition, method = "POST") =>
			fetch(`http://127.0.0.1:${server!.port}${DAEMON_ROUTES.configMcpAdd}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(method === "POST" ? { body: JSON.stringify(body) } : {}),
			});
		return { call, addMcp };
	}
	it("returns HTTP success with warning after commit even when audit storage fails", async () => {
		const { call } = await start(
			vi.fn(() => {
				throw new Error("audit-private-marker");
			}),
		);
		const response = await call(server!.token);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ saved: true, warnings: [expect.any(String)] });
		expect(JSON.stringify(body)).not.toContain("private-marker");
		expect(readSaved().mcpServers.remote.enabled).toBe(false);
	});
	it("denies remote/view/invalid tokens before persisting", async () => {
		const { call, addMcp } = await start();
		for (const token of [server!.remoteToken, server!.viewToken, "wrong-token"])
			expect([401, 403]).toContain((await call(token)).status);
		expect(addMcp).not.toHaveBeenCalled();
		expect(fs.existsSync(file())).toBe(false);
	});
	it("saves only valid launch-token POSTs and never echoes fields", async () => {
		const { call, addMcp } = await start();
		const status = await call(server!.token, undefined, "GET");
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ available: false });
		expect((await call(server!.token, { ...definition, name: "" })).status).toBe(400);
		expect((await call(server!.token, { ...definition, repoId: "missing" })).status).toBe(404);
		expect(addMcp).not.toHaveBeenCalled();
		const response = await call(server!.token);
		expect(response.status).toBe(200);
		expect(await response.text()).not.toContain("private-marker");
		expect(addMcp).toHaveBeenCalledTimes(1);
		const duplicate = await call(server!.token);
		expect(duplicate.status).toBe(409);
		expect(await duplicate.text()).not.toContain("private-marker");
	});
});

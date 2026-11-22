import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigSettingCommand, ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfigSnapshot } from "../../src/octocode/web-daemon/config-status.ts";
import { ConfigWriteError, writeConfigSetting } from "../../src/octocode/web-daemon/config-write.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { trustFolder } from "./helpers.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const SECRET = "SENTINEL-SECRET-77d1";
let root: string;
let agentDir: string;
let cwd: string;
const cleanup: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-write-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "work");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	// Its own agent database: the suite's default one trusts the whole temp folder, which would trust every workspace here.
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: Object.fromEntries(
				[
					["local", "qwen"],
					["global", "first"],
					["workspace", "second"],
				].map(([provider, model]) => [
					provider,
					{ baseUrl: "http://localhost:1/v1", api: "openai-completions", models: [{ id: model }] },
				]),
			),
		}),
	);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const fn of cleanup.splice(0).reverse()) await fn();
	fs.rmSync(root, { recursive: true, force: true });
});

const globalFile = () => path.join(agentDir, "settings.json");
const workspaceFile = () => path.join(cwd, ".octocode", "settings.json");
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const set = (
	partial: Partial<Extract<ConfigSettingCommand, { key: "defaultProvider" | "defaultModel" }>>,
	withCwd = false,
) =>
	writeConfigSetting(
		{ key: "defaultProvider", scope: "global", value: "openai", ...partial },
		{ agentDir, cwd: withCwd ? cwd : undefined },
	);
const snapshotOf = (withCwd = true) =>
	buildConfigSnapshot({ agentDir, cwd: withCwd ? cwd : undefined, keychain: null });

describe("writeConfigSetting", () => {
	it("writes and clears both startup fields together, preserving unrelated settings", async () => {
		fs.writeFileSync(
			globalFile(),
			JSON.stringify({ theme: "dark", defaultProvider: "old", defaultModel: "old-model" }),
		);
		await writeConfigSetting(
			{ key: "modelDefault", scope: "global", value: { provider: "local", model: "qwen" } },
			{ agentDir },
		);
		expect(readJson(globalFile())).toEqual({ theme: "dark", defaultProvider: "local", defaultModel: "qwen" });
		await writeConfigSetting({ key: "modelDefault", scope: "global", value: null }, { agentDir });
		expect(readJson(globalFile())).toEqual({ theme: "dark" });
	});

	it("refuses an unknown provider or model with the closest known ones, and writes nothing", async () => {
		const pair = (provider: string, model: string) =>
			writeConfigSetting({ key: "modelDefault", scope: "global", value: { provider, model } }, { agentDir });
		await expect(pair("locl", "qwen")).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining("local"),
		});
		await expect(pair("local", "qwne")).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining("qwen"),
		});
		expect(fs.existsSync(globalFile())).toBe(false);
		await pair("local", "qwen");
		expect(readJson(globalFile())).toEqual({ defaultProvider: "local", defaultModel: "qwen" });
	});

	it("refuses untrusted or empty paired selections without changing either field", async () => {
		const command = { key: "modelDefault", scope: "workspace", value: { provider: "local", model: "qwen" } } as const;
		await expect(writeConfigSetting(command, { agentDir, cwd })).rejects.toMatchObject({ status: 403 });
		expect(fs.existsSync(workspaceFile())).toBe(false);
		await expect(
			writeConfigSetting({ ...command, scope: "global", value: { provider: " ", model: "qwen" } }, { agentDir }),
		).rejects.toMatchObject({ status: 400 });
		expect(fs.existsSync(globalFile())).toBe(false);
	});

	it("sets both workspace defaults in one trusted operation and restores global inheritance when cleared", async () => {
		trustFolder(cwd);
		await writeConfigSetting(
			{ key: "modelDefault", scope: "global", value: { provider: "global", model: "first" } },
			{ agentDir },
		);
		await writeConfigSetting(
			{ key: "modelDefault", scope: "workspace", value: { provider: "workspace", model: "second" } },
			{ agentDir, cwd },
		);
		expect(readJson(workspaceFile())).toEqual({ defaultProvider: "workspace", defaultModel: "second" });
		expect((await snapshotOf()).settings.map((setting) => setting.value)).toEqual(["workspace", "second"]);
		await writeConfigSetting({ key: "modelDefault", scope: "workspace", value: null }, { agentDir, cwd });
		expect((await snapshotOf()).settings.map((setting) => setting.value)).toEqual(["global", "first"]);
	});
	it("sets and clears a global setting and keeps the keys it does not own", async () => {
		fs.writeFileSync(globalFile(), JSON.stringify({ theme: "dark", defaultModel: "gpt-a" }));
		await set({ key: "defaultProvider", value: "openai" });
		expect(readJson(globalFile())).toEqual({ theme: "dark", defaultModel: "gpt-a", defaultProvider: "openai" });
		expect((await snapshotOf(false)).settings[0]).toEqual({
			key: "defaultProvider",
			value: "openai",
			source: "global",
		});

		await set({ key: "defaultModel", value: null });
		expect(readJson(globalFile())).toEqual({ theme: "dark", defaultProvider: "openai" });
		expect((await snapshotOf(false)).settings[1]).toEqual({ key: "defaultModel", source: "default" });
	});

	it("refuses a workspace write without a workspace or for an untrusted one, and writes nothing", async () => {
		await expect(set({ scope: "workspace" })).rejects.toMatchObject({ status: 400 });
		await expect(set({ scope: "workspace" }, true)).rejects.toMatchObject({ status: 403 });
		await expect(set({ scope: "workspace" }, true)).rejects.toBeInstanceOf(ConfigWriteError);
		expect(fs.existsSync(workspaceFile())).toBe(false);
		// A global write still succeeds for the same untrusted workspace.
		await set({ value: "openai" }, true);
		expect(readJson(globalFile())).toEqual({ defaultProvider: "openai" });
	});

	it("writes a trusted workspace file and shows workspace precedence, then falls back to global when cleared", async () => {
		trustFolder(cwd);
		await set({ value: "openai" });
		await set({ scope: "workspace", value: "anthropic" }, true);
		expect(readJson(workspaceFile())).toEqual({ defaultProvider: "anthropic" });
		expect((await snapshotOf()).settings[0]).toEqual({
			key: "defaultProvider",
			value: "anthropic",
			source: "workspace",
		});

		await set({ scope: "workspace", value: null }, true);
		expect(readJson(workspaceFile())).toEqual({});
		expect((await snapshotOf()).settings[0]).toEqual({ key: "defaultProvider", value: "openai", source: "global" });
	});

	it("never overwrites an invalid settings file and does not quote it", async () => {
		const content = `{ "defaultProvider": ${SECRET}`;
		fs.writeFileSync(globalFile(), content);
		const failure = await set({ value: "openai" }).catch((error: unknown) => error);
		expect(failure).toMatchObject({ status: 409 });
		expect((failure as Error).message).not.toContain(SECRET);
		expect(fs.readFileSync(globalFile(), "utf8")).toBe(content);

		trustFolder(cwd);
		fs.writeFileSync(workspaceFile(), "not json");
		await expect(set({ scope: "workspace" }, true)).rejects.toMatchObject({ status: 409 });
		expect(fs.readFileSync(workspaceFile(), "utf8")).toBe("not json");
	});
});

describe("POST /api/admin/config/settings", () => {
	async function daemon() {
		const { env } = isolatedEnv();
		const server: DaemonServer = await startDaemonServer({
			env,
			onActivity: () => {},
			config: (repo) => snapshotFor(repo?.root),
			writeSetting: (command, repo) => writeConfigSetting(command, { agentDir, cwd: repo?.root }),
			onDrain: () => {},
		});
		cleanup.push(() => server.close());
		const call = (token: string, body: unknown, path = "/api/admin/config/settings", method = "POST") =>
			fetch(`http://127.0.0.1:${server.port}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(method === "POST" ? { body: JSON.stringify(body) } : {}),
			});
		return { server, call };
	}
	const snapshotFor = (root?: string): Promise<ConfigSnapshot> =>
		buildConfigSnapshot({ agentDir, cwd: root, keychain: null });

	it("changes a setting for the launch token and answers with the fresh snapshot", async () => {
		const { server, call } = await daemon();
		const response = await call(server.token, { key: "defaultModel", scope: "global", value: "gpt-5" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as ConfigSnapshot;
		expect(body.writable).toBe(true);
		expect(body.settings[1]).toEqual({ key: "defaultModel", value: "gpt-5", source: "global" });
		expect(readJson(globalFile())).toEqual({ defaultModel: "gpt-5" });
	});

	it("refuses published links, a bad key, scope, value or repository, and a get", async () => {
		const { server, call } = await daemon();
		const good = { key: "defaultModel", scope: "global", value: "gpt-5" };
		expect((await call(server.remoteToken, good)).status).toBe(403);
		expect((await call(server.viewToken, good)).status).toBe(403);
		expect(fs.existsSync(globalFile())).toBe(false);
		for (const bad of [
			{ ...good, key: "packages" },
			{ ...good, scope: "default" },
			{ ...good, value: "line\nbreak" },
			{ ...good, value: "" },
			{ ...good, extra: true },
			{ key: "defaultModel", scope: "global" },
		])
			expect((await call(server.token, bad)).status, JSON.stringify(bad)).toBe(400);
		expect((await call(server.token, { ...good, repoId: "unknown" })).status).toBe(404);
		expect((await call(server.token, good, "/api/admin/config/settings", "GET")).status).toBe(405);
		expect(fs.existsSync(globalFile())).toBe(false);
	});

	it("reports a refusal with its reason, without file content", async () => {
		fs.writeFileSync(globalFile(), `{ "defaultProvider": ${SECRET}`);
		const { server, call } = await daemon();
		const response = await call(server.token, { key: "defaultModel", scope: "global", value: "gpt-5" });
		expect(response.status).toBe(409);
		const text = await response.text();
		expect(text).toContain("invalid");
		expect(text).not.toContain(SECRET);
	});

	it("tells a published link that the page is read-only", async () => {
		const { server, call } = await daemon();
		const body = (await (await call(server.remoteToken, undefined, "/api/config", "GET")).json()) as ConfigSnapshot;
		expect(body.writable).toBe(false);
	});
});

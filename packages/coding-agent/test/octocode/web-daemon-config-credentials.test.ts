import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeychainBackend } from "../../src/core/auth-storage/keychain.ts";
import { configAudits } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { buildConfigSnapshot } from "../../src/octocode/web-daemon/config-status.ts";
import { refusalAuditor, writeConfigCredential } from "../../src/octocode/web-daemon/credential-write.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const SECRET = "SENTINEL-KEY-4f9a1c7e";
const OLD_SECRET = "SENTINEL-OLD-0b3d5e8f";
const ROUTE = "/api/admin/config/credentials";
let root: string;
let agentDir: string;
let keychainDir: string;
const cleanup: Array<() => Promise<void> | void> = [];
/** Provider key checks answer from here; only requests to the local daemon reach the network stack. */
const realFetch = globalThis.fetch;
let providerAnswer: number | Error;
const providerRequests: string[] = [];

beforeEach(() => {
	providerAnswer = 200;
	providerRequests.length = 0;
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
		providerRequests.push(url);
		if (providerAnswer instanceof Error) throw providerAnswer;
		return new Response("{}", { status: providerAnswer });
	});
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-config-credentials-"));
	agentDir = path.join(root, "agent");
	keychainDir = path.join(root, "keychain");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(keychainDir);
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const fn of cleanup.splice(0).reverse()) await fn();
	fs.rmSync(root, { recursive: true, force: true });
});

/** A keychain that keeps entries in a temp folder; its reference is a real command, so a key can be read back. */
function fakeKeychain(options: { failStore?: boolean } = {}): KeychainBackend {
	const file = (provider: string) => path.join(keychainDir, provider);
	return {
		name: "fake keychain",
		store: async (provider, secret) => {
			if (options.failStore) throw new Error(`keychain locked while storing ${secret}`);
			fs.writeFileSync(file(provider), secret);
		},
		remove: async (provider) => fs.rmSync(file(provider), { force: true }),
		referenceFor: (provider) => `!cat ${file(provider)}`,
		isOwnReference: (key, provider) => key === `!cat ${file(provider)}`,
	};
}
const entryOf = (provider: string) => {
	try {
		return fs.readFileSync(path.join(keychainDir, provider), "utf8");
	} catch {
		return undefined;
	}
};
const authFile = () => path.join(agentDir, "auth.json");
const readAuth = (): Record<string, any> => JSON.parse(fs.readFileSync(authFile(), "utf8"));

async function daemon(keychain: KeychainBackend | null) {
	const { env } = isolatedEnv();
	const responses: string[] = [];
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: () => {},
		config: () => buildConfigSnapshot({ agentDir, keychain, env }),
		writeCredential: (command) =>
			writeConfigCredential(command, {
				agentDir,
				keychain,
				env,
				actor: "web:test",
				audit: (entry) => configAudits.record(sharedAgentDb(env).db, entry),
			}),
		auditRefused: refusalAuditor("web:test", (entry) => configAudits.record(sharedAgentDb(env).db, entry)),
		onDrain: () => {},
	});
	cleanup.push(() => server.close());
	const call = async (token: string, body: unknown, route = ROUTE, method = "POST") => {
		const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(method === "POST" ? { body: JSON.stringify(body) } : {}),
		});
		const text = await response.text();
		responses.push(text);
		return { status: response.status, text, json: () => JSON.parse(text) };
	};
	const audits = () => configAudits.recent(sharedAgentDb(env).db, 50);
	return { env, server, call, responses, audits };
}
const set = (provider = "openai", extra: object = {}) => ({ action: "set", provider, key: SECRET, ...extra });
const sourcesOf = (snapshot: ConfigSnapshot, provider: string) =>
	snapshot.providers.find((row) => row.provider === provider)?.sources.map((source) => source.kind);

describe("POST /api/admin/config/credentials", () => {
	it("accepts only the launch token and writes nothing for a published link", async () => {
		const { server, call } = await daemon(fakeKeychain());
		expect((await call(server.remoteToken, set())).status).toBe(403);
		expect((await call(server.viewToken, set())).status).toBe(403);
		expect((await call("wrong", set())).status).toBe(401);
		expect(fs.existsSync(authFile())).toBe(false);
		expect(entryOf("openai")).toBeUndefined();
		expect((await call(server.token, set(), ROUTE, "GET")).status).toBe(405);
		for (const bad of [
			{ ...set(), provider: "Bad Provider" },
			{ ...set(), key: "" },
			{ ...set(), key: "line\nbreak" },
			{ ...set(), extra: true },
			{ action: "set", provider: "openai" },
			{ action: "clear", provider: "openai", key: SECRET },
			{ action: "rename", provider: "openai" },
		])
			expect((await call(server.token, bad)).status, JSON.stringify(bad)).toBe(400);
		expect(fs.existsSync(authFile())).toBe(false);
	});

	it("stores a key in the keychain, keeps only a reference in auth.json, then replaces and clears it", async () => {
		const { server, call } = await daemon(fakeKeychain());
		const saved = await call(server.token, set());
		expect(saved.status).toBe(200);
		expect(sourcesOf(saved.json(), "openai")).toEqual(["keychain"]);
		expect(entryOf("openai")).toBe(SECRET);
		expect(readAuth().openai).toEqual({ type: "api_key", key: `!cat ${path.join(keychainDir, "openai")}` });
		expect(fs.readFileSync(authFile(), "utf8")).not.toContain(SECRET);

		const replaced = await call(server.token, { ...set(), key: OLD_SECRET });
		expect(replaced.status).toBe(200);
		expect(entryOf("openai")).toBe(OLD_SECRET);

		const cleared = await call(server.token, { action: "clear", provider: "openai" });
		expect(cleared.status).toBe(200);
		expect(sourcesOf(cleared.json(), "openai")).toEqual([]);
		expect(entryOf("openai")).toBeUndefined();
		expect(readAuth().openai).toBeUndefined();
	});

	it("refuses a key the provider rejects and saves nothing; saves one it cannot check", async () => {
		const { server, call, audits } = await daemon(fakeKeychain());
		providerAnswer = 401;
		const refused = await call(server.token, set());
		expect(refused.status).toBe(400);
		expect(refused.json().error ?? refused.text).toContain("rejected this key");
		expect(refused.text).not.toContain(SECRET);
		expect(providerRequests).toEqual(["https://api.openai.com/v1/models"]);
		expect(fs.existsSync(authFile())).toBe(false);
		expect(entryOf("openai")).toBeUndefined();
		expect(audits()[0]).toMatchObject({ action: "credential.set", outcome: "refused", errorCode: "rejected" });

		providerAnswer = new TypeError("fetch failed");
		expect((await call(server.token, set())).status).toBe(200);
		expect(entryOf("openai")).toBe(SECRET);
		providerAnswer = 503;
		expect((await call(server.token, { ...set(), key: OLD_SECRET })).status).toBe(200);
		expect(entryOf("openai")).toBe(OLD_SECRET);
	});

	it("refuses an OAuth sign-in being replaced by a key, and keeps other providers' entries", async () => {
		fs.writeFileSync(
			authFile(),
			JSON.stringify({
				anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
				other: { type: "api_key", key: "x" },
			}),
		);
		const { server, call } = await daemon(fakeKeychain());
		expect((await call(server.token, set("anthropic"))).status).toBe(409);
		expect((await call(server.token, set("openai"))).status).toBe(200);
		expect(readAuth().anthropic.type).toBe("oauth");
		expect(readAuth().other).toEqual({ type: "api_key", key: "x" });
	});

	it("refuses a Claude subscription token for any provider and saves nothing", async () => {
		const { server, call } = await daemon(fakeKeychain());
		const token = "sk-ant-oat01-synthetic-token-value";
		const refused = await call(server.token, { action: "set", provider: "anthropic", key: token });
		expect(refused.status).toBe(400);
		expect(refused.text).toContain("Claude Code");
		expect(refused.text).not.toContain(token);
		expect(fs.existsSync(authFile()) ? fs.readFileSync(authFile(), "utf8") : "").not.toContain("sk-ant-oat");
	});

	it("does not fall back to plaintext when the keychain refuses, and does not echo the key", async () => {
		const { server, call } = await daemon(fakeKeychain({ failStore: true }));
		const refused = await call(server.token, set());
		expect(refused.status).toBe(502);
		expect(refused.text).not.toContain(SECRET);
		expect(fs.existsSync(authFile()) ? fs.readFileSync(authFile(), "utf8") : "").not.toContain(SECRET);
	});

	it("removes the new keychain entry when the auth.json write fails (G-K1)", async () => {
		const { server, call } = await daemon(fakeKeychain());
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
		});
		const failed = await call(server.token, set());
		expect(failed.status).toBe(500);
		expect(failed.text).not.toContain(SECRET);
		expect(entryOf("openai")).toBeUndefined();
		expect(fs.existsSync(authFile()) ? (readAuth().openai ?? null) : null).toBeNull();
	});

	it("restores the earlier keychain key when a replacement cannot be written to auth.json", async () => {
		const { server, call } = await daemon(fakeKeychain());
		expect((await call(server.token, { ...set(), key: OLD_SECRET })).status).toBe(200);
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
		});
		expect((await call(server.token, set())).status).toBe(500);
		expect(entryOf("openai")).toBe(OLD_SECRET);
		expect(readAuth().openai.key).toBe(`!cat ${path.join(keychainDir, "openai")}`);
	});

	it("without a keychain saves plaintext only after the acknowledgement", async () => {
		const { server, call, audits } = await daemon(null);
		const refused = await call(server.token, set());
		expect(refused.status).toBe(409);
		expect(refused.json().error).toContain("plain text");
		expect(fs.existsSync(authFile())).toBe(false);
		expect((await call(server.token, set("openai", { acknowledgePlaintext: false }))).status).toBe(409);

		const saved = await call(server.token, set("openai", { acknowledgePlaintext: true }));
		expect(saved.status).toBe(200);
		expect(saved.json().keychainAvailable).toBe(false);
		expect(sourcesOf(saved.json(), "openai")).toEqual(["auth-json"]);
		expect(readAuth().openai).toEqual({ type: "api_key", key: SECRET });
		expect(audits().map((row) => [row.outcome, row.errorCode, row.afterKind])).toEqual([
			["refused", "plaintext", ""],
			["refused", "plaintext", ""],
			["ok", "", "auth-json"],
		]);

		expect((await call(server.token, { action: "clear", provider: "openai" })).status).toBe(200);
		expect(readAuth().openai).toBeUndefined();
	});

	it("refuses an invalid auth.json without changing or quoting it", async () => {
		const content = `{ "openai": ${OLD_SECRET}`;
		fs.writeFileSync(authFile(), content);
		const { server, call } = await daemon(fakeKeychain());
		const refused = await call(server.token, set());
		expect(refused.status).toBe(409);
		expect(refused.text).not.toContain(OLD_SECRET);
		expect(fs.readFileSync(authFile(), "utf8")).toBe(content);
		expect(entryOf("openai")).toBeUndefined();
	});

	it("audits a refused request from the launch page without its provider or key, and ignores unauthenticated ones", async () => {
		const { server, call, audits } = await daemon(fakeKeychain());
		expect((await call(server.token, { ...set("Bad Provider"), extra: true })).status).toBe(400);
		expect((await call("wrong", set())).status).toBe(401);
		// A published link is refused before the route runs; it is not a launch-page attempt.
		expect((await call(server.remoteToken, set())).status).toBe(403);
		const rows = audits();
		expect(rows.map((row) => [row.action, row.target, row.outcome, row.errorCode])).toEqual([
			["credential.refused", "", "refused", "invalid"],
		]);
		expect(JSON.stringify(rows)).not.toContain(SECRET);
		expect(JSON.stringify(rows)).not.toContain("Bad Provider");
	});

	it("audits each attempt with kinds and codes only", async () => {
		const { server, call, audits } = await daemon(fakeKeychain());
		await call(server.token, set());
		await call(server.token, { ...set(), key: OLD_SECRET });
		await call(server.token, { action: "clear", provider: "openai" });
		const rows = audits();
		expect(rows.map((row) => [row.action, row.target, row.beforeKind, row.afterKind, row.outcome])).toEqual([
			["credential.set", "openai", "none", "keychain", "ok"],
			["credential.set", "openai", "keychain", "keychain", "ok"],
			["credential.clear", "openai", "keychain", "none", "ok"],
		]);
		expect(rows.every((row) => row.actor === "web:test")).toBe(true);
	});
});

describe("secret handling", () => {
	it("shows the sentinel key in no response, socket frame, log line or audit row", async () => {
		const logs: string[] = [];
		const capture = (chunk: unknown) => {
			logs.push(String(chunk));
			return true;
		};
		vi.spyOn(process.stdout, "write").mockImplementation(capture);
		vi.spyOn(process.stderr, "write").mockImplementation(capture);
		for (const level of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));

		const { env, server, call, responses, audits } = await daemon(null);
		const repoKey = crypto.randomUUID();
		fixtureBacklog(() => sharedAgentDb(env), repoKey).add({ title: "x", goal: "y", createdBy: "t" }, { id: "t" });
		const frames: string[] = [];
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/r/${repoKey}/api/backlogs/live`, {
			headers: { Origin: `http://127.0.0.1:${server.port}` },
		});
		cleanup.push(() => socket.terminate());
		socket.on("message", (data) => frames.push(String(data)));
		await new Promise<void>((resolve) => socket.on("open", () => resolve()));
		socket.send(JSON.stringify({ token: server.token, protocolVersion: 1 }));
		await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));

		await call(server.token, set("openai", { acknowledgePlaintext: true }));
		await call(server.token, set("openai"));
		await call(server.token, { ...set(), key: `${SECRET}\n` });
		await call(server.remoteToken, set());
		await call(server.token, undefined, "/api/config", "GET");
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(responses.length).toBeGreaterThan(4);
		expect(responses.join("\n")).not.toContain(SECRET);
		expect(frames.join("\n")).not.toContain(SECRET);
		expect(logs.join("\n")).not.toContain(SECRET);
		expect(JSON.stringify(audits())).not.toContain(SECRET);
		expect(audits().length).toBeGreaterThan(1);
	});
});

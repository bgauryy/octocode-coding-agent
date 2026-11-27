import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVICE_WORKER_JS, SERVICE_WORKER_ROUTE, WEB_PREFS_ROUTE } from "@octocodeai/octocode-webview";
import { type AgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { Readable } from "node:stream";
import {
	handleWebPrefsRequest,
	settingsWebPrefs,
	type WebPrefs,
	type WebPrefsStore,
} from "../../src/octocode/browser/page-routes.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import type { BacklogWeb } from "../../src/octocode/backlog/context.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

interface Answer {
	status: number;
	headers: http.IncomingHttpHeaders;
	text: string;
}

/** A raw request, so the test controls Host and Origin as a foreign page would. */
function request(
	port: number,
	path: string,
	options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const body = options.body === undefined ? undefined : JSON.stringify(options.body);
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: options.method ?? "GET",
				headers: { ...(body ? { "content-type": "application/json" } : {}), ...options.headers },
			},
			(res) => {
				let text = "";
				res.on("data", (chunk) => (text += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

function memoryPrefs(): WebPrefsStore & { value: WebPrefs } {
	const store = {
		value: { sound: false, theme: "system" } as WebPrefs,
		read: () => store.value,
		write: (patch: Partial<WebPrefs>) => (store.value = { ...store.value, ...patch }),
	};
	return store;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function expectServiceWorker(answer: Answer) {
	expect(answer.status).toBe(200);
	expect(answer.headers["content-type"]).toBe("text/javascript; charset=utf-8");
	expect(answer.headers["cache-control"]).toBe("no-store");
	expect(answer.text).toBe(SERVICE_WORKER_JS);
}

describe("daemon server: service worker and preferences", () => {
	let server: DaemonServer;
	let prefs: ReturnType<typeof memoryPrefs>;
	beforeEach(async () => {
		prefs = memoryPrefs();
		server = await startDaemonServer({
			env: isolatedEnv().env,
			onActivity: () => {},
			config: async () => ({}),
			onDrain: () => {},
			webPrefs: prefs,
		});
	});
	afterEach(() => server.close());

	it("serves the worker without a token and refuses another origin or host", async () => {
		expectServiceWorker(await request(server.port, SERVICE_WORKER_ROUTE));
		const foreign = await request(server.port, SERVICE_WORKER_ROUTE, { headers: { origin: "https://evil.example" } });
		expect(foreign.status).toBe(403);
		const wrongHost = await request(server.port, SERVICE_WORKER_ROUTE, { headers: { host: "evil.example" } });
		expect(wrongHost.status).toBe(403);
		const own = await request(server.port, SERVICE_WORKER_ROUTE, {
			headers: { origin: `http://127.0.0.1:${server.port}` },
		});
		expect(own.status).toBe(200);
	});

	it("allows the worker in the page's policy header", async () => {
		const page = await request(server.port, "/");
		expect(page.headers["content-security-policy"]).toContain("worker-src 'self'");
	});

	it("keeps preferences behind the token, off by default, and writable only with the launch capability", async () => {
		expect((await request(server.port, WEB_PREFS_ROUTE)).status).toBe(401);
		const read = await request(server.port, WEB_PREFS_ROUTE, { headers: auth(server.token) });
		expect(JSON.parse(read.text)).toEqual({ sound: false, theme: "system" });
		const write = await request(server.port, WEB_PREFS_ROUTE, {
			method: "POST",
			headers: auth(server.token),
			body: { sound: true },
		});
		expect(JSON.parse(write.text)).toEqual({ sound: true, theme: "system" });
		expect(prefs.value).toEqual({ sound: true, theme: "system" });
		const themed = await request(server.port, WEB_PREFS_ROUTE, {
			method: "POST",
			headers: auth(server.token),
			body: { theme: "dark" },
		});
		expect(JSON.parse(themed.text)).toEqual({ sound: true, theme: "dark" });
		for (const token of [server.remoteToken, server.viewToken]) {
			const refused = await request(server.port, WEB_PREFS_ROUTE, {
				method: "POST",
				headers: auth(token),
				body: { sound: false },
			});
			expect(refused.status).toBe(403);
			expect(JSON.parse((await request(server.port, WEB_PREFS_ROUTE, { headers: auth(token) })).text)).toEqual({
				sound: true,
				theme: "dark",
			});
		}
		const invalid = await request(server.port, WEB_PREFS_ROUTE, {
			method: "POST",
			headers: auth(server.token),
			body: { sound: "yes" },
		});
		expect(invalid.status).toBe(400);
		for (const body of [{ theme: "neon" }, {}, { sound: true, extra: 1 }]) {
			const refused = await request(server.port, WEB_PREFS_ROUTE, {
				method: "POST",
				headers: auth(server.token),
				body,
			});
			expect(refused.status).toBe(400);
		}
		expect(prefs.value).toEqual({ sound: true, theme: "dark" });
	});

	it("answers a body over 1 KB with 413 and a wrong content type with 400, and changes nothing", async () => {
		const tooLarge = await request(server.port, WEB_PREFS_ROUTE, {
			method: "POST",
			headers: auth(server.token),
			body: { sound: true, pad: "x".repeat(2000) },
		});
		expect(tooLarge.status).toBe(413);
		const wrongType = await request(server.port, WEB_PREFS_ROUTE, {
			method: "POST",
			headers: { ...auth(server.token), "content-type": "text/plain" },
			body: { sound: true },
		});
		expect(wrongType.status).toBe(400);
		expect(prefs.value).toEqual({ sound: false, theme: "system" });
	});

	it("keeps the settings path out of a failed save's reply", async () => {
		prefs.write = () => {
			throw new Error("EACCES: permission denied, open '/Users/someone/.octocode/agent/settings.json'");
		};
		const failed = await request(server.port, WEB_PREFS_ROUTE, {
			method: "POST",
			headers: auth(server.token),
			body: { theme: "dark" },
		});
		expect(failed.status).toBe(500);
		expect(failed.text).not.toContain("/Users/someone");
		expect(JSON.parse(failed.text).error).toBe("The preferences could not be saved.");
	});
});

describe("session server: service worker and preferences", () => {
	let dir: string;
	let db: AgentDb;
	let web: BacklogWeb;
	let port: number;
	let token: string;
	let prefs: ReturnType<typeof memoryPrefs>;
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-page-routes-"));
		db = openAgentDb(path.join(dir, "db"));
		const store = fixtureBacklog(() => db, "repo");
		prefs = memoryPrefs();
		web = await startWorkspaceWeb(
			{ store, actor: { id: "session", kind: "agent" }, session: "session", repoName: "repo", repoRoot: dir },
			() => {},
			undefined,
			undefined,
			prefs,
		);
		const url = new URL(web.url);
		port = Number(url.port);
		token = url.hash.slice("#access=".length);
	});
	afterEach(async () => {
		await web.close();
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("serves the worker without a token and refuses another origin or host", async () => {
		expectServiceWorker(await request(port, SERVICE_WORKER_ROUTE));
		expect((await request(port, SERVICE_WORKER_ROUTE, { headers: { origin: "https://evil.example" } })).status).toBe(
			403,
		);
		expect((await request(port, SERVICE_WORKER_ROUTE, { headers: { host: "evil.example" } })).status).toBe(403);
	});

	it("keeps preferences behind the token and off by default", async () => {
		expect((await request(port, WEB_PREFS_ROUTE)).status).toBe(401);
		expect(JSON.parse((await request(port, WEB_PREFS_ROUTE, { headers: auth(token) })).text)).toEqual({
			sound: false,
			theme: "system",
		});
		const write = await request(port, WEB_PREFS_ROUTE, { method: "POST", headers: auth(token), body: { sound: true } });
		expect(JSON.parse(write.text)).toEqual({ sound: true, theme: "system" });
		expect(prefs.value).toEqual({ sound: true, theme: "system" });
	});

	it("refuses a write without the launch token (this server has one token, no read-only tier)", async () => {
		const refused = await request(port, WEB_PREFS_ROUTE, { method: "POST", body: { theme: "dark" } });
		expect(refused.status).toBe(401);
		expect(prefs.value).toEqual({ sound: false, theme: "system" });
	});
});

describe("web preferences in the global settings file", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-prefs-"));
	});
	afterEach(() => fs.rmSync(agentDir, { recursive: true, force: true }));

	it("is off without a file, persists as web.sound and keeps the other settings", () => {
		const store = settingsWebPrefs(() => agentDir);
		expect(store.read()).toEqual({ sound: false, theme: "system" });
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "p", web: { window: "browser" } }),
		);
		expect(store.write({ sound: true })).toEqual({ sound: true, theme: "system" });
		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"))).toEqual({
			defaultProvider: "p",
			web: { window: "browser", sound: true },
		});
		expect(settingsWebPrefs(() => agentDir).read()).toEqual({ sound: true, theme: "system" });
		expect(store.write({ theme: "light" })).toEqual({ sound: true, theme: "light" });
		expect(store.write({ sound: false })).toEqual({ sound: false, theme: "light" });
		expect(store.read()).toEqual({ sound: false, theme: "light" });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ web: { theme: "bogus" } }));
		expect(store.read().theme).toBe("system");
	});

	it("keeps the page's error free of the settings path", async () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), "{ not json");
		const replies: { status: number; body: unknown }[] = [];
		const req = Object.assign(Readable.from([Buffer.from('{"theme":"dark"}')]), {
			method: "POST",
			headers: { "content-type": "application/json" },
		}) as unknown as http.IncomingMessage;
		await handleWebPrefsRequest(
			req,
			"/api/web-prefs",
			settingsWebPrefs(() => agentDir),
			(status, body) => replies.push({ status, body }),
			{ workerRoute: "/sw.js", workerSource: "", prefsRoute: "/api/web-prefs" },
		);
		expect(replies).toEqual([
			{
				status: 500,
				body: {
					error:
						"The preferences could not be saved. The global settings file is not valid JSON; fix it in a terminal first.",
				},
			},
		]);
	});

	it("refuses to replace a settings file that does not parse", () => {
		const file = path.join(agentDir, "settings.json");
		fs.writeFileSync(file, "{ not json");
		const store = settingsWebPrefs(() => agentDir);
		expect(() => store.write({ sound: true })).toThrow(/not valid JSON/);
		expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
	});
});

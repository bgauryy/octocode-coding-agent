import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createDaemonApi } from "../src/app/daemon/api.ts";

afterEach(() => vi.unstubAllGlobals());

/** A settings snapshot with the fields the page reads; `marker` tells the routes apart. */
const snapshot = (marker: string) => ({ keychainAvailable: false, providers: [], settings: [], marker });

/** A daemon that answers every route with a valid body and records each request it received. */
function stubDaemon() {
	const replies: Record<string, unknown> = {
		[DAEMON_ROUTES.sessions]: { sessions: [] },
		[DAEMON_ROUTES.repos]: { repos: [] },
		[DAEMON_ROUTES.access]: { writable: true },
		[DAEMON_ROUTES.config]: snapshot("config"),
		[DAEMON_ROUTES.configCredentials]: snapshot("credentials"),
		[DAEMON_ROUTES.configProviders]: snapshot("providers"),
		[DAEMON_ROUTES.configSettings]: snapshot("settings"),
		[DAEMON_ROUTES.configSignin]: { status: "pending", events: [] },
		[DAEMON_ROUTES.configHarness]: { rows: [] },
		[DAEMON_ROUTES.configHarnessPreview]: { id: "harness:claude", label: "Claude Code", items: 0, lines: [] },
		[DAEMON_ROUTES.configTools]: { groups: [], setting: "tools" },
	};
	const fetch = vi.fn(async (url: string, _options: RequestInit) => ({
		ok: true,
		status: 200,
		// A scoped route (`/s/<id>/api/...`) answers like the daemon's own.
		json: async () => replies[url.split("?")[0].replace(/^\/s\/[^/]+/, "")],
	}));
	vi.stubGlobal("fetch", fetch);
	return () => {
		const [url, options] = fetch.mock.calls.at(-1)!;
		return {
			url,
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body === undefined ? undefined : JSON.parse(String(options.body)),
		};
	};
}

it("preserves save warnings and scopes availability requests without secret-bearing replies", async () => {
	const response = { saved: true, message: "Saved", warnings: ["Audit recording unavailable"] };
	const fetch = vi.fn(async (_url: string, options: RequestInit) => ({
		ok: true,
		status: 200,
		json: async () => (options.method === "POST" ? response : { available: false, message: "Open session Settings" }),
	}));
	vi.stubGlobal("fetch", fetch);
	const api = createDaemonApi("token", (route) => `/s/live${route}`);
	expect(await api.mcpAddStatus("session")).toEqual({ available: false, message: "Open session Settings" });
	expect(fetch.mock.calls[0][0]).toBe(`/s/live${DAEMON_ROUTES.configMcpAdd}?repoId=session`);
	expect(
		await api.addMcp({
			name: "test",
			scope: "global",
			transport: "stdio",
			command: "node",
			env: { TOKEN: "private-marker" },
		}),
	).toEqual(response);
});

const READ = { Authorization: "Bearer token" };
const WRITE = { ...READ, "content-type": "application/json" };

it("reads each route with the bearer header and adds repoId only when given", async () => {
	const last = stubDaemon();
	const api = createDaemonApi("token");

	expect(await api.sessions()).toEqual({ sessions: [] });
	expect(last()).toEqual({ url: DAEMON_ROUTES.sessions, method: "GET", headers: READ, body: undefined });
	expect(await api.repos()).toEqual({ repos: [] });
	expect(last()).toEqual({ url: DAEMON_ROUTES.repos, method: "GET", headers: READ, body: undefined });
	expect(await api.access()).toBe(true);
	expect(last()).toEqual({ url: DAEMON_ROUTES.access, method: "GET", headers: READ, body: undefined });

	for (const [call, route] of [
		[api.config, DAEMON_ROUTES.config],
		[api.harness, DAEMON_ROUTES.configHarness],
		[api.tools, DAEMON_ROUTES.configTools],
	] as const) {
		await call();
		expect(last()).toEqual({ url: route, method: "GET", headers: READ, body: undefined });
		await call("repo/one two");
		expect(last()).toEqual({
			url: `${route}?repoId=repo%2Fone%20two`,
			method: "GET",
			headers: READ,
			body: undefined,
		});
	}
});

it("posts each command as JSON with the bearer header and adds repoId only where the call takes it", async () => {
	const last = stubDaemon();
	const api = createDaemonApi("token");
	const command = { kind: "example", value: 1 } as never;

	for (const [call, route] of [
		[api.saveCredential, DAEMON_ROUTES.configCredentials],
		[api.saveProvider, DAEMON_ROUTES.configProviders],
	] as const) {
		await call(command);
		expect(last()).toEqual({ url: route, method: "POST", headers: WRITE, body: command });
		await call(command, "r1");
		expect(last()).toEqual({ url: `${route}?repoId=r1`, method: "POST", headers: WRITE, body: command });
	}

	expect(await api.signIn(command)).toEqual({ status: "pending", events: [] });
	expect(last()).toEqual({ url: DAEMON_ROUTES.configSignin, method: "POST", headers: WRITE, body: command });
	expect(await api.setHarness(command)).toEqual({ rows: [] });
	expect(last()).toEqual({ url: DAEMON_ROUTES.configHarness, method: "POST", headers: WRITE, body: command });
	await api.previewHarness("harness:claude", "r1");
	expect(last().url).toBe(`${DAEMON_ROUTES.configHarnessPreview}?id=harness%3Aclaude&repoId=r1`);
	expect(await api.pinTool(command)).toEqual({ groups: [], setting: "tools" });
	expect(last()).toEqual({ url: DAEMON_ROUTES.configTools, method: "POST", headers: WRITE, body: command });
	expect(await api.saveSetting(command)).toEqual(snapshot("settings"));
	expect(last()).toEqual({ url: DAEMON_ROUTES.configSettings, method: "POST", headers: WRITE, body: command });
});

it("refuses a malformed answer and reports the call's own failure text", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
	);
	const api = createDaemonApi("token");
	await expect(api.saveProvider({} as never)).rejects.toThrow("Could not change the provider");
	await expect(api.pinTool({} as never)).rejects.toThrow("Could not pin the tool");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
	);
	await expect(api.harness()).rejects.toThrow("Invalid harness response");
	await expect(api.tools()).rejects.toThrow("Invalid tools response");
	await expect(api.config()).rejects.toThrow("Invalid settings response");
	await expect(api.saveCredential({} as never)).rejects.toThrow("Invalid settings response");
	await expect(api.saveProvider({} as never)).rejects.toThrow("Invalid settings response");
	await expect(api.saveSetting({} as never)).rejects.toThrow("Invalid settings response");
});

it("places every settings route under the page's scope and leaves the daemon's own routes alone", async () => {
	const last = stubDaemon();
	const scoped = (route: string) => `/s/sess-1${route}`;
	const api = createDaemonApi("token", scoped);
	await api.sessions();
	expect(last().url).toBe(DAEMON_ROUTES.sessions);
	await api.tools("session");
	expect(last().url).toBe(`/s/sess-1${DAEMON_ROUTES.configTools}?repoId=session`);
	await api.config("session");
	expect(last().url).toBe(`/s/sess-1${DAEMON_ROUTES.config}?repoId=session`);
	await api.pinTool({ kind: "native", tool: "web", pin: "deferred", scope: "global" });
	expect(last()).toMatchObject({ url: `/s/sess-1${DAEMON_ROUTES.configTools}`, method: "POST" });
	await api.saveSetting({ key: "x" } as never);
	expect(last().url).toBe(`/s/sess-1${DAEMON_ROUTES.configSettings}`);
});

import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserMcpRequest } from "../../coding-agent/src/octocode/web/browser-mcp.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import { browserPreset } from "../src/presets/browser/index.ts";
import { type BrowserGuard, createBrowserGuard } from "../src/presets/browser/proxy.ts";

const PUBLIC_IP = "93.184.216.34";
/** DNS without the network: `app.test` is public, `rebind.test` answers private, anything else fails to resolve. */
const lookup = async (hostname: string) => {
	if (hostname === "app.test") return [{ address: PUBLIC_IP }];
	if (hostname === "rebind.test") return [{ address: "10.0.0.8" }];
	if (hostname === "flip.test") return [{ address: "127.0.0.1" }];
	throw new Error(`ENOTFOUND ${hostname}`);
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

/** A server on 127.0.0.1: its `/secret` is what a public page must not reach. */
async function secretServer(): Promise<number> {
	const server = http.createServer((_request, response) => response.end("secret"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => {
		server.closeAllConnections();
		server.close();
	});
	return (server.address() as AddressInfo).port;
}

/** A guard whose proxy sends every connection to `target` (the fixture) whatever address it vetted. */
function guardTo(target: number, options: { running?: boolean } = {}): BrowserGuard {
	const guard = createBrowserGuard({
		lookup,
		running: async () => options.running ?? true,
		proxy: { lookup, connect: () => net.connect({ host: "127.0.0.1", port: target }) },
	});
	cleanups.push(() => guard.dispose());
	return guard;
}

/** The proxy URL an `open` call hands Chrome. */
async function proxyOf(guard: BrowserGuard, input: Record<string, unknown> = {}): Promise<URL> {
	const { args } = await guard.call("open", input, tmp());
	const list = (args as { args: string[] }).args;
	return new URL(list[list.indexOf("--proxyServer") + 1]);
}

/** One request as Chrome sends it to an HTTP proxy: the absolute URL on the request line. */
function viaProxy(proxy: URL, target: string): Promise<{ status: number; blocked?: string; body: string }> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{ host: proxy.hostname, port: proxy.port, method: "GET", path: target, headers: { host: new URL(target).host } },
			(response) => {
				let body = "";
				response.on("data", (chunk) => (body += chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						blocked: response.headers["x-octocode-blocked"] as string | undefined,
						body,
					}),
				);
			},
		);
		request.once("error", reject);
		request.end();
	});
}

const goto = (url: string) => ({ plan: { steps: [{ op: "goto", url }] }, connection: { port: 9222 } });

describe("browser MCP page-request filter", () => {
	it("refuses a private request a public page starts, and lets a public one through", async () => {
		const secret = await secretServer();
		const guard = guardTo(secret);
		const proxy = await proxyOf(guard, { url: "http://app.test/" });

		expect(await viaProxy(proxy, "http://app.test/page.png")).toMatchObject({ status: 200, body: "secret" });
		const refused = await viaProxy(proxy, `http://127.0.0.1:${secret}/secret`);
		expect(refused).toMatchObject({ status: 403, blocked: "private" });
		expect(refused.body).not.toContain("secret");
		// A name that resolves private, a numeric spelling of loopback and a name nothing resolves are refused the same way.
		expect(await viaProxy(proxy, "http://rebind.test/x")).toMatchObject({ status: 403, blocked: "private" });
		expect(await viaProxy(proxy, `http://2130706433:${secret}/secret`)).toMatchObject({ status: 403 });
		expect(await viaProxy(proxy, "http://nowhere.test/x")).toMatchObject({ status: 403 });
	});

	it("lets a page reach the private host the agent opened and the permission check asked about", async () => {
		const secret = await secretServer();
		const guard = guardTo(secret);
		const proxy = await proxyOf(guard);
		const url = `http://127.0.0.1:${secret}/`;
		expect(await viaProxy(proxy, `${url}secret`)).toMatchObject({ status: 403 });

		// The permission check asks net.private, the user allows it, and the call runs.
		expect(await browserMcpRequest("mcp__browser__run", goto(url), lookup)).toMatchObject({ action: "net.private" });
		await guard.call("run", goto(url), tmp());
		expect(await viaProxy(proxy, `${url}secret`)).toMatchObject({ status: 200, body: "secret" });

		// Only that host and port: another port of the same address and the other loopback name stay refused.
		expect(await viaProxy(proxy, `http://127.0.0.1:${secret + 1}/secret`)).toMatchObject({ status: 403 });
		expect(await viaProxy(proxy, `http://localhost:${secret}/secret`)).toMatchObject({ status: 403 });
	});

	it("approves nothing for a call that was not run, or a host the check found public", async () => {
		const secret = await secretServer();
		const guard = guardTo(secret);
		const proxy = await proxyOf(guard);
		// The check asked, but the call never ran (the user refused).
		await browserMcpRequest("mcp__browser__run", goto(`http://127.0.0.1:${secret}/`), lookup);
		expect(await viaProxy(proxy, `http://127.0.0.1:${secret}/secret`)).toMatchObject({ status: 403 });
		// DNS rebinding: public when the check ran, private when the call runs. No ask was raised, so no approval is made.
		let answers = [{ address: PUBLIC_IP }];
		const changing = async () => answers;
		expect(await browserMcpRequest("mcp__browser__run", goto("http://flip.test/"), changing)).toBeUndefined();
		answers = [{ address: "127.0.0.1" }];
		await guard.call("run", goto("http://flip.test/"), tmp());
		expect(await viaProxy(proxy, "http://flip.test/secret")).toMatchObject({ status: 403 });
	});

	it("rewrites `open` to start Chrome behind the proxy and leaves other calls alone", async () => {
		const guard = guardTo(1);
		const own = {
			url: "http://app.test/",
			args: ["--proxyServer", "http://evil:1", "--proxyBypassList", "*", "--windowSize", "800x600"],
		};
		const { args } = await guard.call("open", own, tmp());
		const list = (args as { args: string[] }).args;
		// The package refuses typed fields beside `args`, so the typed `url` travels as a launcher flag.
		expect(list.slice(0, 4)).toEqual(["--url", "http://app.test/", "--windowSize", "800x600"]);
		expect(list.filter((item) => item === "--proxyServer")).toHaveLength(1);
		expect(list[list.indexOf("--proxyServer") + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(list[list.indexOf("--proxyBypassList") + 1]).toBe("<-loopback>");
		expect(args.url).toBeUndefined();

		const cleanup = { port: 9222, dryRun: true };
		expect((await guard.call("cleanup", cleanup, tmp())).args).toBe(cleanup);
		const run = goto("http://app.test/");
		expect((await guard.call("run", run, tmp())).args).toBe(run);
		// A malformed `args` is left for the server to reject; nothing starts.
		const bad = { args: "--headless" };
		expect((await guard.call("open", bad, tmp())).args).toBe(bad);
	});

	it("starts the proxy lazily, once, and stops it on dispose; a Chrome still running then fails closed", async () => {
		const started: number[] = [];
		const guard = createBrowserGuard({
			running: async () => true,
			start: async (options) => {
				const { startFilteringProxy } = await import("../../coding-agent/src/octocode/browser/proxy.ts");
				const proxy = await startFilteringProxy(options);
				started.push(proxy.port);
				return proxy;
			},
		});
		await guard.dispose(); // Safe before anything started.
		await guard.call("run", goto("http://app.test/"), tmp());
		expect(started).toEqual([]);
		const proxy = await proxyOf(guard);
		await proxyOf(guard);
		expect(started).toHaveLength(1);

		await guard.dispose();
		await guard.dispose();
		await expect(viaProxy(proxy, "http://app.test/")).rejects.toThrow(/ECONNREFUSED/);
		// The next `open` starts a new proxy.
		await proxyOf(guard);
		expect(started).toHaveLength(2);
		await guard.dispose();
	});

	it("does not start Chrome unfiltered when the proxy cannot start", async () => {
		const guard = createBrowserGuard({
			running: async () => true,
			start: async () => {
				throw new Error("HTTP_PROXY must be an http:// proxy");
			},
		});
		await expect(guard.call("open", { url: "http://app.test/" }, tmp())).rejects.toThrow(/http:\/\/ proxy/);
	});

	it("says when `open` attached to a browser that is not filtered, and which page requests were refused", async () => {
		const secret = await secretServer();
		const guard = guardTo(secret);
		const proxy = await proxyOf(guard);
		const call = await guard.call("open", {}, tmp());
		const reused = {
			content: [{ type: "text" as const, text: "OK" }],
			structuredContent: { result: { reused: true } },
		};
		const note = (result: typeof reused) =>
			call
				.review(result)
				.content.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n");
		expect(note(reused)).toMatch(/already running.*not started behind Octocode's private-address filter/);
		const fresh = { ...reused, structuredContent: { result: { reused: false } } };
		expect(note(fresh)).toBe("OK");

		await viaProxy(proxy, `http://127.0.0.1:${secret}/secret`);
		expect(note(fresh)).toContain(`127.0.0.1:${secret} were refused (403)`);
		expect(note(fresh)).toBe("OK"); // Told once.
	});

	it("sets the WebRTC policy in the isolated profile of a Chrome that is not running yet", async () => {
		const cwd = tmp();
		const guard = guardTo(1, { running: false });
		await guard.call("open", { port: 9333 }, cwd);
		const file = path.join(
			cwd,
			".octocode/octocode-chrome-devtools/tmp/browser-state/cdp-chrome-profile-9333/Default/Preferences",
		);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
			webrtc: { ip_handling_policy: "disable_non_proxied_udp" },
		});
		const real = tmp();
		await guard.call("open", { port: 9444, args: ["--profile", "Default"] }, real);
		expect(fs.existsSync(path.join(real, ".octocode"))).toBe(false);
	});

	it("restores a reused Chrome's filter on its recorded port in a later process, failing closed", async () => {
		const secret = await secretServer();
		const cwd = tmp();
		let chromeRunning = false;
		const guardFor = () => {
			const guard = createBrowserGuard({
				lookup,
				running: async () => chromeRunning,
				proxy: { lookup, connect: () => net.connect({ host: "127.0.0.1", port: secret }) },
			});
			cleanups.push(() => guard.dispose());
			return guard;
		};
		const text = (result: { content: Array<{ type: string; text?: string }> }) =>
			result.content.map((block) => block.text ?? "").join("\n");
		const reused = { content: [{ type: "text" as const, text: "OK" }], structuredContent: { data: { reused: true } } };

		// The first run starts Chrome behind its proxy and records the port.
		const first = guardFor();
		const launched = await first.call("open", { port: 9555 }, cwd);
		const list = (launched.args as { args: string[] }).args;
		const proxy = new URL(list[list.indexOf("--proxyServer") + 1]);
		chromeRunning = true;
		// The same process opening again reuses a filtered browser: no proxy flags (the package would warn), no note.
		const again = await first.call("open", { port: 9555 }, cwd);
		expect((again.args as { args: string[] }).args).not.toContain("--proxyServer");
		expect(text(again.review(reused))).toBe("OK");

		// The first process ends (its subagent run settled); Chrome keeps running.
		await first.dispose();
		await expect(viaProxy(proxy, "http://app.test/")).rejects.toThrow(/ECONNREFUSED/);

		// A follow-up run in a new process reuses the Chrome: the filter comes back on the same port.
		const second = guardFor();
		const call = await second.call("open", { port: 9555 }, cwd);
		expect(text(call.review(reused))).toMatch(/restored its private-address filter/);
		const refused = await viaProxy(proxy, `http://127.0.0.1:${secret}/secret`);
		expect(refused.status).toBe(403);
		expect((await viaProxy(proxy, "http://app.test/")).body).toBe("secret"); // Public loads pass (fixture answers all).
	});

	it("treats a recorded proxy port held by another live process as filtered", async () => {
		const cwd = tmp();
		const holder = net.createServer();
		await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
		const held = (holder.address() as AddressInfo).port;
		const stateDir = path.join(cwd, ".octocode/octocode-chrome-devtools/tmp/browser-state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "octocode-proxy-9666.json"), JSON.stringify({ proxyPort: held }));
		const guard = guardTo(1, { running: true });
		const call = await guard.call("open", { port: 9666 }, cwd);
		const result = call.review({ content: [{ type: "text", text: "OK" }], structuredContent: { reused: true } });
		expect(result.content).toEqual([{ type: "text", text: "OK" }]);
	});

	it("moves typed `open` fields into launcher args, which the package requires once args are present", async () => {
		const guard = guardTo(1, { running: false });
		const { args } = await guard.call("open", { port: 9777, url: "https://app.test/", headless: true }, tmp());
		expect(Object.keys(args)).toEqual(["args"]);
		expect((args as { args: string[] }).args.slice(0, 5)).toEqual([
			"--port",
			"9777",
			"--url",
			"https://app.test/",
			"--headless",
		]);
		const visible = await guard.call("open", { port: 9778, headless: false }, tmp());
		expect((visible.args as { args: string[] }).args).not.toContain("--headless");
	});

	it("stops the proxy when the preset is disposed", async () => {
		const preset = browserPreset();
		expect(preset.dispose).toBeTypeOf("function");
		await preset.dispose!();
		await preset.dispose!();
	});
});

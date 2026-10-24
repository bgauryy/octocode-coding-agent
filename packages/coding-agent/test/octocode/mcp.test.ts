import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configuredOctocodeServer,
	OctocodeMcp,
	reconnectOctocodeMcp,
	registerOctocodeMcp,
} from "../../src/octocode/mcp/octocode.ts";
import { octocodeToolDefinition, sanitizeJson, toToolResult } from "../../src/octocode/mcp/tools.ts";
import { TEXT_MAX_CHARS } from "../../src/octocode/shared/turn-budget.ts";
import { isOctocodeTool } from "../../src/octocode/shared/octocode-tools.ts";
import { saveDecision } from "../../src/octocode/shared/trust.ts";
import { fakeCtx, fakePi, rendered, theme } from "./fake-pi.ts";
import { noisyPng, pixelSize, tmp } from "./helpers.ts";
import { OCTOCODE_MCP_SPEC, octocodeLaunch } from "../../src/octocode/mcp/octocode/launch.ts";
import { fingerprint, projectConfigFiles } from "../../src/octocode/shared/trust/files.ts";

const ECHO = path.join(import.meta.dirname, "fixtures", "echo-mcp.mjs");
const PROGRESS = path.join(import.meta.dirname, "fixtures", "progress-mcp.mjs");
const progressServer = (cwd: string) => ({ command: process.execPath, args: [PROGRESS], cwd, env: {} });
const echo = (cwd: string) => ({ command: process.execPath, args: [ECHO], cwd, env: {} });
const exits = (cwd: string, stderr = "kaboom") => ({
	command: process.execPath,
	args: ["-e", `require('node:fs').writeSync(2, ${JSON.stringify(stderr)}); process.exit(3)`],
	cwd,
	env: {},
});
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const ensureDiscovery = vi.fn();
beforeEach(() => ensureDiscovery.mockClear());

/** An Octocode MCP wired to a fake Octocode and a stdio launch the test chooses. */
function session(
	launch: (cwd: string) => ReturnType<typeof echo>,
	options: { env?: NodeJS.ProcessEnv; hasUI?: boolean; connectWaitMs?: number; ensureDiscovery?: () => void } = {},
) {
	const fake = fakePi();
	const cwd = tmp();
	const ctx = fakeCtx({ cwd, hasUI: options.hasUI ?? true });
	const mcp = new OctocodeMcp(fake.pi, {
		launch,
		env: { ...options.env },
		version: "1.2.3",
		connectWaitMs: options.connectWaitMs ?? 20_000,
		...(options.ensureDiscovery ? { ensureDiscovery: options.ensureDiscovery } : {}),
	});
	const call = async (tool: string, params: Record<string, unknown> = {}, signal?: AbortSignal) =>
		(await fake.tools.get(`mcp__octocode__${tool}`).execute("call-1", params, signal, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
			isError?: boolean;
		};
	return { fake, cwd, ctx, mcp, call, notes: ctx.ui.notes };
}
const text = (result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text ?? "").join("");

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Octocode MCP calls", () => {
	it("forwards the server's progress to the tool's updates, so it renews the idle timeout", async () => {
		const { fake, ctx, mcp } = session(progressServer);
		await mcp.start(ctx);
		await mcp.ready(ctx);
		const updates: Array<{ content: Array<{ text?: string }> }> = [];
		await fake.tools
			.get("mcp__octocode__progress")!
			.execute("call-1", {}, undefined, (update: { content: Array<{ text?: string }> }) => updates.push(update), ctx);
		expect(updates.map((update) => update.content[0].text)).toEqual(["halfway"]);
		await mcp.close();
	});

	it("starts the built-in server with the host environment, which carries its tokens", async () => {
		vi.stubEnv("OCTOCODE_TEST_HOST_TOKEN", "from-host");
		const { call, ctx, mcp } = session(progressServer);
		await mcp.start(ctx);
		await mcp.ready(ctx);
		expect(text(await call("hostenv", { name: "OCTOCODE_TEST_HOST_TOKEN" }))).toBe("from-host");
		await mcp.close();
	});
});

describe("Octocode MCP launch and ownership", () => {
	it("launches the bundled octocode-mcp with the workspace allowed", () => {
		const launch = octocodeLaunch("/work/app", { OCTOCODE_HOME: "/h/.octocode" }, "/x/octocode-mcp/bin.js");
		expect(launch).toEqual({
			command: process.execPath,
			args: ["/x/octocode-mcp/bin.js"],
			cwd: "/work/app",
			env: { WORKSPACE_ROOT: "/work/app", ALLOWED_PATHS: "/work/app,/h/.octocode/agent/sessions" },
		});
		// The real bundled bin resolves (octocode-mcp is a dependency).
		expect(fs.existsSync(octocodeLaunch("/w").args[0])).toBe(true);
	});

	it("keeps Octocode's home state (trust store, credentials, database) out of the readers' roots", () => {
		const home = "/h/.octocode";
		const { env } = octocodeLaunch("/work/app", { OCTOCODE_HOME: home }, "/x/bin.js", ["/skills/review"]);
		const roots = env.ALLOWED_PATHS.split(",");
		expect(roots).toEqual(["/work/app", `${home}/agent/sessions`, "/skills/review"]);
		expect(roots).not.toContain(home);
		// Spilled output and bash logs, which the model reads back, are under the session folders.
		expect(path.join(home, "pi-trust.json").startsWith(`${roots[1]}${path.sep}`)).toBe(false);
	});

	it("turns off project language-server config for an untrusted project only", () => {
		const trusted = octocodeLaunch("/w", {}, "/x/bin.js", [], true);
		const untrusted = octocodeLaunch("/w", {}, "/x/bin.js", [], false);
		expect(trusted.env).not.toHaveProperty("OCTOCODE_TRUST_PROJECT_LSP_CONFIG");
		expect(untrusted.env.OCTOCODE_TRUST_PROJECT_LSP_CONFIG).toBe("false");
	});

	it("runs the octocode-mcp range of package.json: the dependency and the npx fallback share it", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../..", "package.json"), "utf8")) as {
			dependencies: Record<string, string>;
		};
		const range = manifest.dependencies["octocode-mcp"];
		expect(OCTOCODE_MCP_SPEC).toBe(`octocode-mcp@${range}`);
		if (range.startsWith("file:"))
			expect(() => octocodeLaunch("/w", {}, "")).toThrow("local octocode-mcp build is missing");
		else expect(octocodeLaunch("/w", {}, "")).toMatchObject({ command: "npx", args: ["-y", `octocode-mcp@${range}`] });
	});

	it("refuses the npx fallback in an untrusted project", () => {
		const range = OCTOCODE_MCP_SPEC.slice("octocode-mcp@".length);
		if (range.startsWith("file:")) return;
		expect(() => octocodeLaunch("/w", {}, "", [], false)).toThrow(/npx fallback runs only in a trusted project/);
		expect(octocodeLaunch("/w", {}, "", [], true).command).toBe("npx");
		// An installed server needs no fallback, whatever the trust.
		expect(octocodeLaunch("/w", {}, "/x/bin.js", [], false).args).toEqual(["/x/bin.js"]);
	});

	it("reads an octocode entry from Octocode's mcp.json, the trusted project file replacing the global one", () => {
		const agentDir = tmp();
		const cwd = tmp();
		expect(configuredOctocodeServer(cwd, true, agentDir)).toBeUndefined();
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "x", enabled: false }, other: {} } }),
		);
		fs.mkdirSync(path.join(cwd, ".octocode"));
		fs.writeFileSync(
			path.join(cwd, ".octocode", "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "y" } } }),
		);
		expect(configuredOctocodeServer(cwd, false, agentDir)).toEqual({ command: "x", enabled: false });
		expect(configuredOctocodeServer(cwd, true, agentDir)).toEqual({ command: "y" });
		fs.writeFileSync(path.join(cwd, ".octocode", "mcp.json"), JSON.stringify({ mcpServers: "none" }));
		expect(configuredOctocodeServer(cwd, true, agentDir)).toEqual({ command: "x", enabled: false });
		fs.writeFileSync(path.join(cwd, ".octocode", "mcp.json"), "{ not json");
		expect(configuredOctocodeServer(cwd, true, agentDir)).toEqual({ command: "x", enabled: false });
	});

	it("recognizes Octocode-named Octocode tools", () => {
		expect(isOctocodeTool("mcp__octocode__localSearch")).toBe(true);
		expect(isOctocodeTool("octocode_localSearch")).toBe(false);
		expect(isOctocodeTool("mcp__other__x")).toBe(false);
	});

	it("inherits global settings for a trusted project MCP override, but replaces them for a new transport", () => {
		const agentDir = tmp();
		const cwd = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OCTOCODE_HOME", tmp());
		fs.mkdirSync(path.join(cwd, ".octocode"));
		const projectConfig = path.join(cwd, ".octocode", "mcp.json");
		const global = { command: "octocode-mcp", enabled: false, env: { TEST: "kept" } };
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { octocode: global } }));
		const writeProject = (octocode: unknown) =>
			fs.writeFileSync(projectConfig, JSON.stringify({ mcpServers: { octocode } }));
		writeProject({ exposure: "direct" });
		expect(configuredOctocodeServer(cwd, true, agentDir)).toEqual({ ...global, exposure: "direct" });
		const mcp = new OctocodeMcp(fakePi().pi);
		const ctx = fakeCtx({ cwd });
		expect(mcp.owner(ctx)).toEqual({ by: "user", enabled: false });
		writeProject({ enabled: true, toolExposure: { localFetch: "direct" } });
		expect(configuredOctocodeServer(cwd, true, agentDir)).toEqual({
			...global,
			enabled: true,
			toolExposure: { localFetch: "direct" },
		});
		// Changed project content is not trusted until /trust records it: the global entry still owns.
		expect(mcp.owner(ctx)).toEqual({ by: "user", enabled: false });
		saveDecision(cwd, fingerprint(projectConfigFiles(cwd)), true);
		expect(mcp.owner(ctx)).toEqual({ by: "user", enabled: true });
		expect(configuredOctocodeServer(cwd, false, agentDir)).toEqual(global);
		writeProject({ command: "replacement" });
		expect(configuredOctocodeServer(cwd, true, agentDir)).toEqual({ command: "replacement" });
		writeProject({ enabled: true, env: { TEST: "invalid override" } });
		expect(configuredOctocodeServer(cwd, true, agentDir)).toEqual(global);
		fs.unlinkSync(path.join(agentDir, "mcp.json"));
		writeProject({ enabled: false });
		expect(configuredOctocodeServer(cwd, true, agentDir)).toBeUndefined();
	});

	it("is owned by the user's mcp.json entry, else by this extension, unless OCTOCODE_MCP=0", () => {
		const agentDir = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
		const cwd = tmp();
		const ctx = { cwd, isProjectTrusted: () => false };
		const owner = (env: NodeJS.ProcessEnv = {}) => new OctocodeMcp(fakePi().pi, { env }).owner(ctx);
		expect(owner()).toEqual({ by: "extension" });
		expect(owner({ OCTOCODE_MCP: "0" })).toEqual({ by: "off" });
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "octocode-mcp" } } }),
		);
		expect(owner()).toEqual({ by: "user", enabled: true });
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "false", enabled: false } } }),
		);
		// The user's entry wins even over OCTOCODE_MCP=0, and `enabled: false` is the user's way to turn Octocode off.
		expect(owner({ OCTOCODE_MCP: "0" })).toEqual({ by: "user", enabled: false });
		expect(new OctocodeMcp(fakePi().pi).owner({ cwd, isProjectTrusted: undefined as never })).toEqual({
			by: "user",
			enabled: false,
		});
	});

	it("starts nothing for a user-owned or switched-off server, and says so", async () => {
		const launch = vi.fn((cwd: string) => echo(cwd));
		const agentDir = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
		const off = session(launch, { env: { OCTOCODE_MCP: "0" } });
		await off.mcp.start(off.ctx);
		expect(await off.mcp.ready(off.ctx)).toBe(false);
		expect(off.mcp.describe()).toBe("Octocode MCP: off (OCTOCODE_MCP=0)");
		fs.writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "octocode-mcp" } } }),
		);
		const own = session(launch);
		await own.mcp.start(own.ctx);
		expect(own.mcp.describe()).toContain("your own `octocode` server from mcp.json");
		expect(own.mcp.instructions).toBeUndefined();
		expect(launch).not.toHaveBeenCalled();
		expect(own.fake.tools.size).toBe(0);
	});
});

describe("Octocode MCP client", () => {
	it("connects at session start, declares a small catalog directly, and keeps the instructions", async () => {
		const { fake, ctx, mcp, call } = session(echo, { ensureDiscovery });
		await mcp.start(ctx);
		expect(await mcp.ready(ctx)).toBe(true);
		const names = [...fake.tools.keys()].sort();
		expect(names).toEqual(
			["crash", "exit", "fail", "grow", "localFetch", "pick", "roots", "shout", "shrink"].map(
				(name) => `mcp__octocode__${name}`,
			),
		);
		const shout = fake.tools.get("mcp__octocode__shout");
		expect(shout).toMatchObject({
			description: "Uppercase the given text",
			exposure: "direct",
			namespace: { name: "mcp__octocode", instructions: "Echo test server." },
		});
		expect(fake.tools.get("mcp__octocode__localFetch")).toMatchObject({ exposure: "direct" });
		expect(ensureDiscovery).not.toHaveBeenCalled();
		// The server's JSON Schema is the tool's parameter schema as is.
		expect(shout.parameters).toMatchObject({
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		});
		expect(mcp.instructions).toBe("Echo test server.");
		expect(text(await call("shout", { text: "hello" }))).toBe("HELLO");
		const status = mcp.status();
		expect(status).toMatchObject({
			state: "connected",
			serverName: "echo",
			serverVersion: "1.0.0",
			tools: 9,
			cwd: ctx.cwd,
		});
		expect(mcp.describe()).toBe(`Octocode MCP: connected (echo 1.0.0, 9 tools, pid ${status.pid})`);
		await mcp.close();
		expect(alive(status.pid!)).toBe(false);
		expect(mcp.status().state).toBe("closed");
	});

	it("returns a server error as an error result and honours an aborted call", async () => {
		const { ctx, mcp, call } = session(echo);
		await mcp.start(ctx);
		await mcp.ready(ctx);
		expect(await call("fail")).toMatchObject({ isError: true, content: [{ type: "text", text: "boom" }] });
		const aborted = new AbortController();
		aborted.abort();
		await expect(call("shout", { text: "x" }, aborted.signal)).rejects.toThrow();
		await mcp.close();
	});

	it("follows tools/list_changed: a new tool registers, a withdrawn one is hidden", async () => {
		const { fake, ctx, mcp, call } = session(echo);
		const registered = vi.spyOn(fake.pi, "registerTool");
		await mcp.start(ctx);
		await mcp.ready(ctx);
		const shout = fake.tools.get("mcp__octocode__shout");
		registered.mockClear();
		await call("grow");
		await vi.waitFor(() => expect(fake.tools.get("mcp__octocode__late")).toMatchObject({ exposure: "direct" }));
		expect(mcp.status().tools).toBe(10);
		expect(registered).toHaveBeenCalledTimes(1);
		expect(fake.tools.get("mcp__octocode__shout")).toBe(shout);
		registered.mockClear();
		// A tool the server withdraws is hidden from the model, not left callable.
		await call("shrink");
		await vi.waitFor(() => expect(fake.tools.get("mcp__octocode__late")).toMatchObject({ exposure: "hidden" }));
		expect(mcp.status().tools).toBe(9);
		expect(registered).toHaveBeenCalledTimes(1);
		expect(fake.tools.get("mcp__octocode__shout")).toBe(shout);
		// Reintroducing a withdrawn tool makes it callable again without replacing the unchanged tools.
		registered.mockClear();
		await call("grow");
		await vi.waitFor(() => expect(fake.tools.get("mcp__octocode__late")).toMatchObject({ exposure: "direct" }));
		expect(registered).toHaveBeenCalledTimes(1);
		expect(text(await call("late"))).toBe("late tool works");
		await mcp.close();
	});

	it("keeps unchanged definitions on reconnect and refreshes changed tools or namespace instructions", async () => {
		let instructions = "First instructions";
		let description = "Uppercase the given text";
		const { fake, ctx, mcp, call } = session((cwd) => ({
			...echo(cwd),
			env: { ECHO_INSTRUCTIONS: instructions, ECHO_SHOUT_DESCRIPTION: description },
		}));
		const registered = vi.spyOn(fake.pi, "registerTool");
		try {
			await mcp.start(ctx);
			await mcp.ready(ctx);
			const shout = fake.tools.get("mcp__octocode__shout");
			registered.mockClear();
			await mcp.restart(ctx);
			expect(registered).toHaveBeenCalledTimes(mcp.status().tools * 2);
			expect(
				registered.mock.calls.slice(0, mcp.status().tools).every(([definition]) => definition.exposure === "hidden"),
			).toBe(true);
			expect(fake.tools.get("mcp__octocode__shout")).toBe(shout);
			expect(text(await call("shout", { text: "reconnected" }))).toBe("RECONNECTED");
			registered.mockClear();
			description = "Updated uppercase description";
			await mcp.restart(ctx);
			expect(registered).toHaveBeenCalledTimes(mcp.status().tools * 2);
			expect(fake.tools.get("mcp__octocode__shout").description).toBe(description);
			registered.mockClear();
			instructions = "New instructions";
			await mcp.restart(ctx);
			expect(registered).toHaveBeenCalledTimes(mcp.status().tools * 2);
			expect(fake.tools.get("mcp__octocode__shout").namespace.instructions).toBe(instructions);
		} finally {
			await mcp.close();
		}
	});

	it("reconnects once after the process dies, then reports a clear error until restart", async () => {
		let launches = 0;
		const { ctx, mcp, call } = session((cwd) =>
			++launches === 2 ? echo(cwd) : launches === 1 ? echo(cwd) : exits(cwd),
		);
		await mcp.start(ctx);
		await mcp.ready(ctx);
		const first = mcp.status().pid!;
		expect(text(await call("exit"))).toBe("bye");
		await vi.waitFor(() => expect(mcp.status().state).toBe("disconnected"));
		expect(mcp.describe()).toContain("Octocode MCP: stopped");
		// The next call reconnects once and carries on.
		expect(text(await call("shout", { text: "again" }))).toBe("AGAIN");
		expect(launches).toBe(2);
		expect(mcp.status().pid).not.toBe(first);
		// Dies again; the one reconnect fails: a clear error, and no further attempts until restart.
		await call("exit");
		await vi.waitFor(() => expect(mcp.status().state).toBe("disconnected"));
		await expect(call("shout", { text: "x" })).rejects.toThrow(/Octocode MCP server is not available: .*kaboom/s);
		expect(launches).toBe(3);
		await expect(call("shout", { text: "x" })).rejects.toThrow("not available");
		expect(launches).toBe(3);
		expect(mcp.status().state).toBe("failed");
		launches = 1;
		await mcp.restart(ctx);
		expect(text(await call("shout", { text: "back" }))).toBe("BACK");
		await mcp.close();
	});

	it("shows controls in the server's instructions as visible escapes, never dropped", async () => {
		const { fake, ctx, mcp } = session((cwd) => ({
			...echo(cwd),
			env: { ECHO_INSTRUCTIONS: "Use it.\u001b]0;pwned\u0007\u202e" },
		}));
		await mcp.start(ctx);
		expect(await mcp.ready(ctx)).toBe(true);
		const expected = "Use it.\\u{1b}]0;pwned\\u{7}\\u{202e}";
		expect(mcp.instructions).toBe(expected);
		expect(fake.tools.get("mcp__octocode__shout").namespace.instructions).toBe(expected);
		await mcp.close();
	});

	it("registers tools without a namespace instructions block when the server has none", async () => {
		const { fake, ctx, mcp } = session(echo, {});
		const quiet = (cwd: string) => ({ ...echo(cwd), env: { ECHO_INSTRUCTIONS: "" } });
		const silent = new OctocodeMcp(fake.pi, { launch: quiet, env: {} });
		await silent.start(ctx);
		expect(await silent.ready(ctx)).toBe(true);
		expect(silent.instructions).toBeUndefined();
		expect(fake.tools.get("mcp__octocode__shout").namespace).toEqual({ name: "mcp__octocode" });
		await Promise.all([silent.close(), mcp.close()]);
	});

	it("describes every state it can be in", () => {
		const mcp = new OctocodeMcp(fakePi().pi, { env: {} });
		const say = (status: object) => {
			(mcp as unknown as { server: { status: () => object } }).server.status = () => status;
			(mcp as unknown as { owned: unknown }).owned = { by: "extension" };
			return mcp.describe();
		};
		expect(say({ state: "idle", tools: 0 })).toContain("not started");
		expect(say({ state: "connected", tools: 2 })).toBe("Octocode MCP: connected (octocode-mcp, 2 tools, pid ?)");
		expect(say({ state: "failed", tools: 0 })).toContain("failed to start: unknown error");
		expect(say({ state: "disconnected", tools: 0 })).toContain("stopped: the server exited");
		expect(say({ state: "closed", tools: 0 })).toContain("not started");
		expect(say({ state: "connected", tools: 1, serverName: "x", pid: 7 })).toBe(
			"Octocode MCP: connected (x, 1 tools, pid 7)",
		);
	});

	it("says so when the server dies during a call, and starts it again for the next one", async () => {
		const { ctx, mcp, call } = session(echo);
		await mcp.start(ctx);
		await mcp.ready(ctx);
		await expect(call("crash")).rejects.toThrow("Octocode MCP server stopped during the call");
		expect(text(await call("shout", { text: "next" }))).toBe("NEXT");
		await mcp.close();
	});

	it("shows terminal escape sequences in the server stderr as visible escapes in the failure text and the notice", async () => {
		const { ctx, mcp, notes } = session((cwd) => exits(cwd, "boom \u001b]0;pwned\u0007\u001b[31mred\u001b[0m\u202e!"));
		await mcp.start(ctx);
		expect(await mcp.ready(ctx)).toBe(false);
		const error = mcp.status().error!;
		expect(error).toContain("boom \\u{1b}]0;pwned\\u{7}\\u{1b}[31mred\\u{1b}[0m\\u{202e}!");
		expect(error).not.toMatch(/[\u001b\u0007\u202e]/);
		expect(notes[0].message).not.toMatch(/[\u001b\u0007\u202e]/);
	});

	it("reports a failed connect at once: notifies once, retries once on a later ready, then stays failed", async () => {
		const launch = vi.fn((cwd: string) => exits(cwd));
		const { fake, ctx, mcp, notes } = session(launch);
		await mcp.start(ctx);
		const started = Date.now();
		expect(await mcp.ready(ctx)).toBe(false);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(mcp.status()).toMatchObject({ state: "failed", tools: 0 });
		expect(mcp.status().error).toContain("kaboom");
		expect(notes).toHaveLength(1);
		expect(notes[0].message).toContain("Octocode MCP failed to start");
		expect(notes[0].message).toContain("kaboom");
		expect(mcp.describe()).toContain("failed to start");
		expect(mcp.instructions).toBeUndefined();
		// A later prompt retries once; it fails again without another notice, and the one after does not even launch.
		expect(await mcp.ready(ctx)).toBe(false);
		expect(await mcp.ready(ctx)).toBe(false);
		expect(launch).toHaveBeenCalledTimes(2);
		expect(notes).toHaveLength(1);
		expect(fake.tools.size).toBe(0);
	});

	it("stays quiet without a UI", async () => {
		const { ctx, mcp, notes } = session(exits, { hasUI: false });
		await mcp.start(ctx);
		expect(await mcp.ready(ctx)).toBe(false);
		expect(notes).toHaveLength(0);
	});

	it("waits for a slow connect no longer than its bound, and ends it with the session", async () => {
		const hangs = (cwd: string) => ({
			command: process.execPath,
			args: ["-e", "setTimeout(() => {}, 60000)"],
			cwd,
			env: {},
		});
		const { ctx, mcp } = session(hangs, { connectWaitMs: 0 });
		await mcp.start(ctx);
		expect(await mcp.ready(ctx)).toBe(false);
		expect(mcp.status().state).toBe("connecting");
		expect(mcp.describe()).toBe("Octocode MCP: connecting…");
		const done = new AbortController();
		done.abort();
		expect(await mcp.ready({ ...ctx, signal: done.signal })).toBe(false);
		const aborted = new AbortController();
		const waiting = session(hangs, { connectWaitMs: 30_000 });
		await waiting.mcp.start(waiting.ctx);
		const pending = waiting.mcp.ready({ ...waiting.ctx, signal: aborted.signal });
		aborted.abort();
		expect(await pending).toBe(false);
		await Promise.all([mcp.close(), waiting.mcp.close()]);
		expect(mcp.status().state).toBe("closed");
	});

	it("moves to the new folder when the session folder changes, and a restart gets a fresh process", async () => {
		const folders: string[] = [];
		const { ctx, mcp, call } = session((cwd) => {
			folders.push(cwd);
			return echo(cwd);
		});
		await mcp.start(ctx);
		await mcp.ready(ctx);
		const first = mcp.status().pid!;
		await mcp.start(ctx);
		expect(mcp.status().pid).toBe(first);
		const other = { ...ctx, cwd: tmp() } as typeof ctx;
		await mcp.start(other);
		expect(await mcp.ready(other)).toBe(true);
		expect(folders).toEqual([ctx.cwd, other.cwd]);
		await vi.waitFor(() => expect(alive(first)).toBe(false));
		const second = mcp.status().pid!;
		expect(text(await call("shout", { text: "ok" }))).toBe("OK");
		expect((await mcp.restart(other)).pid).not.toBe(second);
		await vi.waitFor(() => expect(alive(second)).toBe(false));
		await mcp.close();
		expect(mcp.status().state).toBe("closed");
	});

	it("wires start and shutdown to the session", async () => {
		const fake = fakePi();
		const mcp = registerOctocodeMcp(fake.pi);
		expect(mcp).toBeInstanceOf(OctocodeMcp);
		const ctx = fakeCtx({ cwd: tmp() });
		vi.stubEnv("OCTOCODE_MCP", "0");
		await fake.emit("session_start", {}, ctx);
		expect(mcp.describe()).toContain("off");
		await fake.emit("session_shutdown", {}, ctx);
		expect(mcp.status().state).toBe("closed");
	});

	it("reports that the local readers are unavailable when the server is off, so the file tool credits bash reads", async () => {
		const fake = fakePi();
		const reports: boolean[] = [];
		registerOctocodeMcp(fake.pi, undefined, true, (unavailable) => reports.push(unavailable));
		const ctx = fakeCtx({ cwd: tmp() });
		vi.stubEnv("OCTOCODE_MCP", "0");
		await fake.emit("session_start", {}, ctx);
		expect(reports.at(-1)).toBe(true);
		await fake.emit("session_shutdown", {}, ctx);
	});
});

describe("native discovery for deferred tools", () => {
	const started = async (autoEnable?: boolean) => {
		const agentDir = tmp();
		if (autoEnable !== undefined)
			fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ autoEnableCodemode: autoEnable }));
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OCTOCODE_MCP", "1");
		const fake = fakePi();
		fake.pi.registerTool({ name: "tool_search", defaultActive: false, reachesTools: () => "all" } as never);
		const mcp = registerOctocodeMcp(fake.pi);
		const ctx = fakeCtx({ cwd: tmp(), model: { contextWindow: 100, compat: { supportsToolSearch: true } } });
		await fake.emit("session_start", {}, ctx);
		return { fake, mcp, ctx };
	};

	it("activates tool_search when the built-in server registers its non-local tools", async () => {
		const { fake, mcp, ctx } = await started();
		try {
			expect(await mcp.ready(ctx)).toBe(true);
			expect(fake.pi.getActiveTools()).toContain("tool_search");
			expect(fake.tools.get("mcp__octocode__localFetch")).toMatchObject({ exposure: "direct" });
			expect(fake.tools.get("mcp__octocode__ghSearchCode")).toMatchObject({ exposure: "deferred" });
		} finally {
			await fake.emit("session_shutdown", {}, ctx);
		}
	}, 60_000);

	it("activates native discovery even when autoEnableCodemode is false", async () => {
		const { fake, mcp, ctx } = await started(false);
		try {
			expect(await mcp.ready(ctx)).toBe(true);
			expect(fake.pi.getActiveTools()).toContain("tool_search");
			expect(fake.pi.getActiveTools()).not.toContain("codemode");
		} finally {
			await fake.emit("session_shutdown", {}, ctx);
		}
	}, 60_000);
});

describe("Octocode MCP restarts for skill folders", () => {
	it("restarts only when the readable folders change, and not while a call runs", async () => {
		const fake = fakePi();
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		let folders = ["/skills/a", "/skills/b"];
		const mcp = new OctocodeMcp(fake.pi, {
			env: {},
			connectWaitMs: 20_000,
			skillDirectories: () => folders,
		});
		try {
			await mcp.start(ctx);
			await mcp.ready(ctx);
			const pid = mcp.status().pid;
			expect(pid).toBeDefined();
			// The same folders in another order, or listed twice, change nothing the server may read.
			folders = ["/skills/b", "/skills/a", "/skills/a"];
			await mcp.ready(ctx);
			expect(mcp.status().pid).toBe(pid);
			// A new folder restarts it.
			folders = ["/skills/a", "/skills/b", "/skills/c"];
			await mcp.ready(ctx);
			await vi.waitFor(() => expect(mcp.status().pid).not.toBe(pid));
			const second = mcp.status().pid;
			await mcp.ready(ctx);
			expect(mcp.status().pid).toBe(second);
		} finally {
			await mcp.close();
		}
	}, 60_000);
});

describe("/mcp reconnect octocode", () => {
	it("restarts the server Octocode runs and reports its state", async () => {
		const { ctx, mcp } = session(echo);
		await mcp.start(ctx);
		await mcp.ready(ctx);
		const pid = mcp.status().pid;
		// A successful restart returns nothing to show; the server runs again under a new process.
		expect(await reconnectOctocodeMcp(mcp)(ctx)).toBeUndefined();
		expect(mcp.describe()).toMatch(/^Octocode MCP: connected/);
		expect(mcp.describe()).not.toContain(`pid ${pid})`);
		await mcp.close();
		// Nothing to restart when the user's own server or nobody runs it.
		vi.stubEnv("OCTOCODE_MCP", "0");
		const off = new OctocodeMcp(fakePi().pi, { env: { OCTOCODE_MCP: "0" } });
		expect(await reconnectOctocodeMcp(off)(ctx)).toContain("Nothing to restart");
	});
});

describe("Octocode tool results and rendering", () => {
	const tool = {
		name: "localFetch",
		description: " Read files ",
		inputSchema: { type: "object" as const },
		annotations: { readOnlyHint: true, title: "x" },
	};
	const binding = {
		namespace: { name: "mcp__octocode" },
		call: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	it("applies the generic path's name and schema rules to the server's tools", () => {
		const odd = octocodeToolDefinition({ name: "odd-tool.v2", inputSchema: {} }, binding);
		expect(odd.name).toBe("mcp__octocode__odd_tool_v2");
		expect(odd.parameters).toMatchObject({ type: "object", properties: {} });
		expect(octocodeToolDefinition(tool, binding).name).toBe("mcp__octocode__localFetch");
		const long = octocodeToolDefinition({ name: "x".repeat(80), inputSchema: { type: "object" } }, binding);
		expect(long.name.length).toBeLessThanOrEqual(64);
	});

	it("gives a page over 20 KB to the model whole: no cut, no marker, non-ASCII intact", async () => {
		const page = `${"- row: héllo wörld — 日本語\n".repeat(1_100)}  next:\n    continueChars: { charOffset: 20000 }\n${"- last row ✓\n".repeat(300)}`;
		expect(Buffer.byteLength(page)).toBeGreaterThan(40 * 1024);
		expect(page.length).toBeLessThan(TEXT_MAX_CHARS);
		const result = await toToolResult(
			"localFetch",
			{
				content: [
					{ type: "text", text: page },
					{ type: "image", data: "aW1n", mimeType: "image/png" },
				],
			},
			false,
		);
		expect(result.content).toEqual([
			{ type: "text", text: page },
			{ type: "image", data: "aW1n", mimeType: "image/png" },
		]);
		expect(result).not.toHaveProperty("structuredContent");
		expect(result).not.toHaveProperty("isError");
	});

	it("spills text over the budget to a file and replaces an oversized image by a note naming its file", async () => {
		const huge = `${"- row: some repository text\n".repeat(12_000)}tail line`;
		expect(Buffer.byteLength(huge)).toBeGreaterThan(300_000);
		const bigImage = "A".repeat(700_000);
		const result = await toToolResult(
			"localSearch",
			{
				content: [
					{ type: "text", text: huge },
					{ type: "image", data: bigImage, mimeType: "image/png" },
					{ type: "image", data: "aW1n", mimeType: "image/png" },
				],
			},
			false,
		);
		const [text, dropped, kept] = result.content as Array<{ type: string; text?: string; data?: string }>;
		expect(text.text!.length).toBeLessThanOrEqual(TEXT_MAX_CHARS);
		expect(text.text).toContain("tail line");
		const textFile = /Full output: (\S+?); search/.exec(text.text!)?.[1];
		expect(fs.readFileSync(textFile!.replace(/^~/, os.homedir()), "utf8")).toBe(huge);
		expect(textFile).toMatch(/mcp_localSearch/);
		expect(dropped).toMatchObject({ type: "text" });
		const imageFile = /Saved to (\S+?)\.\]/.exec(dropped.text!)?.[1];
		expect(fs.statSync(imageFile!).size).toBe(Buffer.from(bigImage, "base64").length);
		expect(kept).toEqual({ type: "image", data: "aW1n", mimeType: "image/png" });
	});

	it("turns other blocks into text, an empty error into a message, and keeps structuredContent only when declared", async () => {
		const linked = await toToolResult(
			"t",
			{ content: [{ type: "resource_link", uri: "file:///a", name: "a" }] },
			false,
		);
		expect(linked.content).toHaveLength(1);
		expect(linked.content[0]).toMatchObject({ type: "text" });
		expect(await toToolResult("t", { content: [], isError: true }, false)).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "t failed without a message." }],
		});
		const structured = { content: [{ type: "text" as const, text: "{}" }], structuredContent: { a: 1 } };
		expect((await toToolResult("t", structured, true)).structuredContent).toEqual({ a: 1 });
		expect(await toToolResult("t", structured, false)).not.toHaveProperty("structuredContent");
	});

	it("keeps local research direct when the host defers other tools", () => {
		const exposure = (name: string) =>
			octocodeToolDefinition({ ...tool, name }, { ...binding, exposure: "deferred" }).exposure;
		for (const name of ["localFetch", "localSearch", "structureSearch", "astSearch", "lspSearch"])
			expect(exposure(name)).toBe("direct");
		for (const name of ["ghSearchCode", "artifactSearch", "ghStructure"]) expect(exposure(name)).toBe("deferred");
	});

	it("defines the Octocode tool from the listed tool: name, hints, schema, declared output", async () => {
		const definition = octocodeToolDefinition(tool, binding);
		expect(definition).toMatchObject({
			name: "mcp__octocode__localFetch",
			label: "localFetch",
			description: "Read files",
			exposure: "direct",
			annotations: { readOnlyHint: true },
			parameters: tool.inputSchema,
		});
		expect(definition.outputSchema).toEqual({});
		expect(octocodeToolDefinition({ ...tool, name: "localSearch" }, binding)).not.toHaveProperty("outputSchema");
		const withOutput = octocodeToolDefinition(
			{ ...tool, title: "Fetch", description: undefined, annotations: undefined, outputSchema: { type: "object" } },
			binding,
		);
		expect(withOutput).toMatchObject({ label: "Fetch", description: "Fetch", outputSchema: { type: "object" } });
		expect(withOutput).not.toHaveProperty("annotations");
		expect(octocodeToolDefinition({ name: "x", inputSchema: {} }, binding).description).toBe("Octocode tool x");
		const out = (await definition.execute("id", { queries: [] }, undefined, undefined, {} as never)) as {
			content: unknown;
		};
		expect(out.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("resizes an oversized image to the active model's image limit and keeps the coordinate note", async () => {
		const original = noisyPng(512);
		const image = { type: "image" as const, data: original.toString("base64"), mimeType: "image/png" };
		const withImage = { ...binding, call: async () => ({ content: [image] }) };
		const run = async (model: unknown) => {
			const out = (await octocodeToolDefinition(tool, withImage).execute("id", {}, undefined, undefined, {
				model,
			} as never)) as { content: Array<{ type: string; text?: string; data?: string }> };
			return {
				shown: out.content.find((part) => part.type === "image")!,
				note: out.content.find((part) => part.type === "text")!.text!,
			};
		};
		const small = await run({ inputLimits: { images: { resize: { maxWidth: 120, maxHeight: 90 } } } });
		expect(pixelSize(small.shown.data!)).toEqual({ width: 90, height: 90 });
		expect(small.note).toContain("original 512x512, displayed at 90x90");
		expect(fs.readFileSync(/Original saved to (\S+?\.png)\./.exec(small.note)![1])).toEqual(original);
		// A model without image metadata gets the default 1568 px limit, which this image already fits: only the byte budget applies.
		const unknown = await run(undefined);
		expect(pixelSize(unknown.shown.data!)).toEqual({ width: 512, height: 512 });
		expect(
			(await toToolResult("t", { content: [image] }, false, { maxWidth: 60, maxHeight: 60 })).content.map(
				(part) => part.type,
			),
		).toEqual(["image", "text"]);
	}, 120_000); // CPU-bound wasm resize: seconds alone, several times that on a loaded machine

	it("renders a call by what it looks for and a result as a compact block", () => {
		const definition = octocodeToolDefinition(tool, binding);
		const context = (extra: object = {}) =>
			({
				lastComponent: undefined,
				state: {},
				args: {},
				toolCallId: "c",
				invalidate: () => undefined,
				cwd: "/w",
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
				...extra,
			}) as never;
		const header = (args: object) => rendered(definition.renderCall!(args, theme, context()));
		expect(header({ queries: [{ path: ".", searchText: "add" }] })).toContain("localFetch(add in .)");
		const batch = header({ queries: [{ path: "a.ts" }, { path: "b.ts" }] });
		expect(batch).toContain("localFetch(2 queries)");
		expect(batch).toContain("a.ts");
		expect(batch).toContain("b.ts");
		expect(header({})).toContain("localFetch");
		const ok = rendered(
			definition.renderResult!(
				{ content: [{ type: "text", text: "line one\nline two" }], details: { tool: "localFetch" } } as never,
				{ expanded: false, isPartial: false },
				theme,
				context(),
			),
		);
		expect(ok).toContain("line one");
		const failed = rendered(
			definition.renderResult!(
				{ content: [{ type: "text", text: "It broke\nwith detail" }], details: { tool: "localFetch" } } as never,
				{ expanded: true, isPartial: false },
				theme,
				context({ isError: true }),
			),
		);
		expect(failed).toContain("It broke");
		expect(failed).toContain("with detail");
	});
});

describe("Octocode result size budgets", () => {
	const fileOf = (shown: string) =>
		fs.readFileSync(/Full output: (\S+?); search/.exec(shown)![1].replace(/^~/, os.homedir()), "utf8");
	/** A page like the server's: rows, then the `next` continuation at the very end. */
	const page = (bytes: number, mark: string) =>
		`${"- row: some repository text\n".repeat(Math.ceil(bytes / 28))}next:\n  continueChars: { charOffset: ${mark} }\n`;
	const shown = (result: Awaited<ReturnType<typeof toToolResult>>) => (result.content[0] as { text: string }).text;

	it.each([
		["BMP text", "日".repeat(50_000)],
		["astral text", "😀".repeat(25_000)],
		["short lines", "x\n".repeat(25_000)],
	])("passes a character-bounded page of %s whole", async (_name, body) => {
		const full = `${body}\nnext:\n  continueChars: { charOffset: 50000 }\n`;
		expect(shown(await toToolResult("localFetch", { content: [{ type: "text", text: full }] }, false))).toBe(full);
	});

	it("keeps the character cap above a server page plus its header", () => {
		expect(TEXT_MAX_CHARS).toBeGreaterThan(50_100);
		expect(TEXT_MAX_CHARS).toBeLessThanOrEqual(64_000);
	});

	it("passes a server page of 50,052 bytes (the largest measured) whole", async () => {
		const full = `${"x".repeat(50_000)}\n${"y".repeat(51)}`;
		expect(Buffer.byteLength(full)).toBe(50_052);
		expect(shown(await toToolResult("localFetch", { content: [{ type: "text", text: full }] }, false))).toBe(full);
	});

	it("spills a part over the cap whole: the preview keeps the tail where `next` lives and names the file holding all of it", async () => {
		const huge = page(120_000, "777");
		const result = await toToolResult("localSearch", { content: [{ type: "text", text: huge }] }, false);
		const text = shown(result);
		expect(text.length).toBeLessThanOrEqual(TEXT_MAX_CHARS);
		expect(text).toContain("continueChars: { charOffset: 777 }");
		expect(text).toMatch(/\[… \d+ lines omitted …\]/);
		expect(fileOf(text)).toBe(huge);
	});

	it("reports an oversized structured result as an error and saves complete JSON", async () => {
		const value = { required: "x".repeat(TEXT_MAX_CHARS + 1) };
		const result = await toToolResult(
			"typed",
			{ content: [{ type: "text", text: "success" }], structuredContent: value },
			true,
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		const file = /Full JSON: (.+)\. Request/.exec(shown(result))![1];
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(value);
	});
});

describe("Octocode result sanitizing", () => {
	it("shows control and invisible characters as escapes in tool results: text parts and structured content, clean ones untouched", async () => {
		const dirty = "a\u202eb\u{e0041}\u{e0042}c\u001b]0;title\u0007d\u001b[31me\u0000f";
		const result = await toToolResult(
			"localSearch",
			{
				content: [
					{ type: "text", text: dirty },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
				structuredContent: { files: [{ path: "p", text: dirty, n: 1 }] },
			},
			true,
		);
		const shown = "a\\u{202e}b\\u{e0041}\\u{e0042}c\\u{1b}]0;title\\u{7}d\\u{1b}[31me\\u{0}f";
		expect(result.content).toEqual([
			{ type: "text", text: shown },
			{ type: "image", data: "x", mimeType: "image/png" },
		]);
		expect(result.structuredContent).toEqual({ files: [{ path: "p", text: shown, n: 1 }] });
		const clean = { a: ["x", { b: "tab\there\n" }], n: 1 };
		expect(sanitizeJson(clean)).toBe(clean);
		expect(sanitizeJson([dirty, 1, null])).toEqual([shown, 1, null]);
	});

	it("keeps what a file holds visible to the model: ZWJ, BOM, bidi, tag characters and CRLF", async () => {
		const text = '1\tok = "a\u200db"\r\n2\tBOM\ufeffmid\r\n3\tzero\u200bwidth \u202eevil\u202c\n4\ttag\u{e0041}\rend';
		const result = await toToolResult("localFetch", { content: [{ type: "text", text }] }, false);
		expect(result.content).toEqual([
			{
				type: "text",
				text: '1\tok = "a\\u{200d}b"\r\n2\tBOM\\u{feff}mid\r\n3\tzero\\u{200b}width \\u{202e}evil\\u{202c}\n4\ttag\\u{e0041}\\rend',
			},
		]);
		// Nothing raw that steers a terminal is left.
		expect(JSON.stringify(result.content)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u202a-\u202e\u200b-\u200d\ufeff]/u);
		// Raw CR never stands alone: only the CR of a CRLF pair, which the terminal draws as a line break, is left.
		expect((result.content[0] as { text: string }).text.replaceAll("\r\n", "")).not.toContain("\r");
	});
});

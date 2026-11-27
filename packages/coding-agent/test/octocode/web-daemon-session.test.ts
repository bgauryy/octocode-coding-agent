import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSessionAttach } from "../../src/octocode/web-daemon/attach-register.ts";
import { stopWebDaemon } from "../../src/octocode/web-daemon/launcher.ts";
import { daemonOpener } from "../../src/octocode/web-daemon/open.ts";
import { attachRecordPath, webDaemonPaths } from "../../src/octocode/web-daemon/paths.ts";
import { readAttachRecord, readDaemonRecord } from "../../src/octocode/web-daemon/records.ts";
import type { WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { webCommand } from "../../src/octocode/workspace/command.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { fakeSession, isolatedEnv } from "./web-daemon-fixture.ts";

const entry = fileURLToPath(new URL("../../src/octocode/web-daemon/entry.ts", import.meta.url));
const resolver = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

function session(env: NodeJS.ProcessEnv, options: { isSubagent?: boolean } = {}) {
	const fake = fakeHost();
	const dir = path.dirname(env.OCTOCODE_AGENT_DB!);
	const ctx = fakeCtx({ cwd: dir });
	const live = fakeSession(ctx.sessionManager.getSessionId());
	const workspace = { bind: vi.fn(() => live.workspace) } as unknown as WorkspaceRuntime;
	const attach = registerSessionAttach(fake.api, { isSubagent: options.isSubagent ?? false, workspace, env });
	return { fake, ctx, attach, workspace, id: ctx.sessionManager.getSessionId() };
}

describe("session attach registration", () => {
	it("starts an owner-only endpoint at session_start and removes it at shutdown, with no setting or flag", async () => {
		const { env } = isolatedEnv();
		const { fake, ctx, id } = session(env);
		await fake.fire("session_start", {}, ctx);
		const file = attachRecordPath(env, id);
		await vi.waitFor(() => expect(readAttachRecord(file)?.sessionId).toBe(id));
		expect(readAttachRecord(file)).toMatchObject({ pid: process.pid, cwd: ctx.cwd });
		await fake.fire("session_shutdown", {}, ctx);
		await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
	});

	it("never attaches a subagent", async () => {
		const { env } = isolatedEnv();
		const { fake, ctx, attach } = session(env, { isSubagent: true });
		await fake.fire("session_start", {}, ctx);
		expect(await attach.ensure(ctx)).toBeUndefined();
		expect(fs.existsSync(webDaemonPaths(env).attachDir)).toBe(false);
	});
});

describe("/web with the daemon", () => {
	const command = (open: any, daemon?: any) => webCommand(open, daemon);

	it("opens the session's own server in a host without a daemon", async () => {
		const open = vi.fn(async () => {});
		const ctx = fakeCtx({ cwd: "/tmp" });
		await command(open).handler("backlogs", ctx);
		expect(open).toHaveBeenCalledWith(ctx, "board");
		expect(ctx.ui.notes.at(-1)).toEqual({
			message: expect.stringContaining("Keep this session open for live updates"),
			type: "info",
		});
	});

	it("uses the daemon when it opens, and falls back with a visible warning when it fails", async () => {
		const open = vi.fn(async () => {});
		const ctx = fakeCtx({ cwd: "/tmp" });
		// The daemon opener answers with what it did and the daemon's idle limit, which the notice repeats.
		await command(
			open,
			vi.fn(async () => ({ opened: true, pid: 1, idleMinutes: 10 })),
		).handler("", ctx);
		expect(open).not.toHaveBeenCalled();
		expect(ctx.ui.notes.at(-1)?.message).toMatch(
			/keeps running after this session closes and stops by itself after 10 minutes/,
		);
		const failing = fakeCtx({ cwd: "/tmp" });
		await command(
			open,
			vi.fn(async () => Promise.reject(new Error("no port"))),
		).handler("", failing);
		expect(open).toHaveBeenCalledWith(failing, "activity");
		expect(failing.ui.notes.map((note) => note.type)).toContain("warning");
		expect(failing.ui.notes.some((note) => note.message.includes("no port"))).toBe(true);
		// The warning comes first and says the session serves the page; then where it opened.
		expect(failing.ui.notes.map((note) => note.type)).toEqual(["warning", "info"]);
		expect(failing.ui.notes[0].message).toContain("this session serves the page itself");
	});

	it("starts one detached daemon, attaches this session and opens the page on it", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const { fake, ctx, attach, id } = session(env);
		await fake.fire("session_start", {}, ctx);
		const opened: string[] = [];
		const open = daemonOpener(attach, {
			env,
			invocation: { command: process.execPath, prefix: ["--import", resolver, entry] },
			open: async (url) => void opened.push(url),
		});
		const handler = webCommand(async () => "http://127.0.0.1/", open);
		await handler.handler("backlogs", ctx);
		const record = readDaemonRecord(webDaemonPaths(env).record)!;
		cleanup.push(() => {
			try {
				process.kill(record.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			return attach.ensure(ctx).then((endpoint) => endpoint?.close());
		});
		expect(
			opened,
			ctx.ui.notes
				.filter((note) => note.type === "warning")
				.map((note) => note.message)
				.join("\n"),
		).toHaveLength(1);
		// What goes through a process argument holds a one-time code, never the launch token.
		const launch = new URLSearchParams(new URL(record.url).hash.slice(1)).get("access")!;
		expect(opened[0]).not.toContain(launch);
		const door = await fetch(opened[0], { redirect: "manual" });
		expect(door.status).toBe(303);
		expect((await fetch(opened[0], { redirect: "manual" })).status).toBe(401);
		const url = new URL(door.headers.get("location")!, new URL(record.url).origin);
		expect(url.origin).toBe(new URL(record.url).origin);
		expect(url.pathname).toBe("/");
		expect(url.searchParams.get("s")).toBe(id);
		const fragment = new URLSearchParams(url.hash.slice(1));
		expect(fragment.get("view")).toBe("board");
		expect(fragment.get("access")).toBe(new URLSearchParams(new URL(record.url).hash.slice(1)).get("access"));
		const sessions = await fetch(url.origin + "/api/sessions", {
			headers: { Authorization: `Bearer ${fragment.get("access")}` },
		});
		expect((await sessions.json()).sessions).toEqual([expect.objectContaining({ id, attached: true })]);
		// A second /web reuses the same daemon.
		await handler.handler("", ctx);
		expect(new URL(opened[1]).origin).toBe(url.origin);
		expect(readDaemonRecord(webDaemonPaths(env).record)!.nonce).toBe(record.nonce);
	});

	it("/web names the daemon's process and its idle limit, and /web stop ends it (or says none runs)", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "7" });
		const { fake, ctx, attach } = session(env);
		await fake.fire("session_start", {}, ctx);
		const open = daemonOpener(attach, {
			env,
			invocation: { command: process.execPath, prefix: ["--import", resolver, entry] },
			open: async () => undefined,
		});
		const handler = webCommand(
			async () => "http://127.0.0.1/",
			open,
			() => stopWebDaemon(env),
		);
		await handler.handler("", ctx);
		const record = readDaemonRecord(webDaemonPaths(env).record)!;
		const alive = () => {
			try {
				process.kill(record.pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		cleanup.push(() => {
			if (alive()) process.kill(record.pid, "SIGKILL");
			return attach.ensure(ctx).then((endpoint) => endpoint?.close());
		});
		expect(ctx.ui.notes.at(-1)!.message).toContain(`/processes lists it as octocode-agent-web-${record.pid}`);
		// The daemon reports the limit it enforces, so the notice never says the default for a changed setting.
		expect(ctx.ui.notes.at(-1)!.message).toContain("stops by itself after 7 minutes");
		await handler.handler("stop", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain(`Stopped the web daemon (pid ${record.pid})`);
		// The record goes at once, so the next /web starts a new daemon; with no page open the process exits.
		expect(readDaemonRecord(webDaemonPaths(env).record)).toBeUndefined();
		await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 10_000 });
		await handler.handler("stop", ctx);
		expect(ctx.ui.notes.at(-1)).toEqual({ message: "No web daemon is running.", type: "info" });
	});
});

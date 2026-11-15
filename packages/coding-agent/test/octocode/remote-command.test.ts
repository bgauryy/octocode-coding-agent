import { afterEach, describe, expect, it } from "vitest";
import { registerRemoteAutoStart, remoteCommand, type RemoteHost } from "../../src/octocode/remote/command.ts";
import { runRemoteCli } from "../../src/octocode/remote/cli.ts";
import { webDaemonPaths } from "../../src/octocode/web-daemon/paths.ts";
import { writeDaemonRecord } from "../../src/octocode/web-daemon/records.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function daemon() {
	const { env } = isolatedEnv();
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: () => {},
		config: async () => ({ protocolVersion: 1, providers: [] }),
		onDrain: () => {},
	});
	cleanup.push(() => server.close());
	return { env, server, origin: `http://127.0.0.1:${server.port}`, token: server.token };
}

function host(
	daemonOf: () => Promise<{ origin: string; token: string }>,
	settings: RemoteHost["settings"] = () => ({}),
): RemoteHost {
	return { daemon: daemonOf, settings };
}

describe("/remote", () => {
	it("publishes a control link with the ssh forward and a QR code, a view link on request, then status and stop", async () => {
		const { server, origin, token } = await daemon();
		const command = remoteCommand(host(async () => ({ origin, token })));
		const ctx = fakeCtx({ cwd: "/tmp" });
		await command.handler("", ctx);
		expect(ctx.ui.notes.at(-1)).toEqual({ message: "Cancelled: nothing was published.", type: "info" });
		ctx.ui.confirms.push(true);
		await command.handler("", ctx);
		const control = ctx.ui.notes.at(-1)!;
		expect(control.type).toBe("info");
		expect(control.message).toContain(`ssh -N -L ${server.port}:127.0.0.1:${server.port}`);
		expect(control.message).toContain(`http://127.0.0.1:${server.port}/#access=${server.remoteToken}`);
		expect(control.message).not.toContain(token);
		expect(control.message).toContain("can send commands and answer approvals");
		expect(control.message).toMatch(/[█▀▄]/);
		await command.handler("view", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain(`#access=${server.viewToken}`);
		expect(ctx.ui.notes.at(-1)!.message).toContain("can read every session on this machine");
		expect(ctx.ui.notes.at(-1)!.message).toContain("nothing can be sent through it");
		await command.handler("status", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/control link over ssh[\s\S]*view link over ssh/);
		expect(ctx.ui.notes.at(-1)!.message).not.toContain("#access");
		await command.handler("stop", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("Stopped publishing");
		await command.handler("status", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain("Nothing is published");
		await command.handler("nonsense", ctx);
		expect(ctx.ui.notes.at(-1)).toEqual({ message: "Usage: /remote [view|status|stop]", type: "warning" });
	});

	it("explains when the daemon cannot start, and prints no QR without a UI", async () => {
		const ctx = fakeCtx({ cwd: "/tmp" });
		const broken = remoteCommand(
			host(async () => {
				throw new Error("no daemon today");
			}),
		);
		for (const word of ["", "status", "stop"]) {
			ctx.ui.confirms.push(true);
			await broken.handler(word, ctx);
			expect(ctx.ui.notes.at(-1)).toEqual({ message: expect.stringContaining("no daemon today"), type: "error" });
		}
		const { origin, token } = await daemon();
		const headless = fakeCtx({ cwd: "/tmp", hasUI: false });
		const command = remoteCommand(host(async () => ({ origin, token })));
		await command.handler("view", headless);
		expect(headless.ui.notes.at(-1)!.message).toContain("http://");
		expect(headless.ui.notes.at(-1)!.message).not.toMatch(/[█▀▄]/);
		// Nobody can agree to a control link: it is refused and points to the explicit command.
		await command.handler("", headless);
		expect(headless.ui.notes.at(-1)).toEqual({
			message: expect.stringContaining("octocode remote link"),
			type: "warning",
		});
		expect(headless.ui.notes.at(-1)!.message).not.toContain("http://");
	});

	it("uses the configured transport: a relay link when settings say so, with the relay from settings", async () => {
		const { origin, token } = await daemon();
		const command = remoteCommand(
			host(
				async () => ({ origin, token }),
				() => ({ transport: "relay", relayUrl: "ws://127.0.0.1:1/relay" }),
			),
		);
		const ctx = fakeCtx({ cwd: "/tmp" });
		await command.handler("view", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(
			/Open on the other device: http:\/\/127\.0\.0\.1:1\/relay\/#k=[\w-]{43}/,
		);
		const missing = remoteCommand(
			host(
				async () => ({ origin, token }),
				() => ({ transport: "relay" }),
			),
		);
		ctx.ui.confirms.push(true);
		await missing.handler("", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/relay address/);
	});

	it("auto-starts a link at session start only when settings ask for it", async () => {
		const { origin, token, server } = await daemon();
		for (const autoStart of [undefined, "off"] as const) {
			const fake = fakeHost();
			registerRemoteAutoStart(
				fake.api,
				host(
					async () => ({ origin, token }),
					() => ({ autoStart }),
				),
			);
			const ctx = fakeCtx({ cwd: "/tmp" });
			await fake.fire("session_start", {}, ctx);
			expect(ctx.ui.notes).toEqual([]);
		}
		const fake = fakeHost();
		registerRemoteAutoStart(
			fake.api,
			host(
				async () => ({ origin, token }),
				() => ({ autoStart: "view" }),
			),
		);
		const ctx = fakeCtx({ cwd: "/tmp" });
		await fake.fire("session_start", {}, ctx);
		expect(ctx.ui.notes.at(-1)!.message).toContain(`#access=${server.viewToken}`);
		expect(ctx.ui.notes.at(-1)!.message).not.toMatch(/[█▀▄]/);
	});
});

describe("octocode remote", () => {
	function record(env: NodeJS.ProcessEnv, server: DaemonServer) {
		writeDaemonRecord(webDaemonPaths(env).record, {
			pid: process.pid,
			port: server.port,
			url: `http://127.0.0.1:${server.port}/#access=${server.token}`,
			protocolVersion: 1,
			build: server.build,
			startedAt: Date.now(),
			nonce: server.nonce,
		});
	}
	const io = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out: (t: string) => out.push(t), err: (t: string) => err.push(t), lines: out, errors: err };
	};

	it("lists sessions and links as JSON, publishes links, and stops, through the running daemon", async () => {
		const { env, server } = await daemon();
		record(env, server);
		const first = io();
		expect(await runRemoteCli(["list", "--json"], env, first)).toBe(0);
		expect(JSON.parse(first.lines[0])).toEqual({ sessions: [], unavailable: [], remote: { links: [] } });
		const link = io();
		expect(await runRemoteCli(["link", "view", "--no-qr"], env, link)).toBe(0);
		expect(link.lines[0]).toContain(`#access=${server.viewToken}`);
		const listed = io();
		expect(await runRemoteCli(["list"], env, listed)).toBe(0);
		expect(listed.lines[0]).toBe("No sessions are attached to the web daemon.");
		expect(listed.lines[1]).toMatch(/^view link over ssh, issued .*, id [0-9a-f]{8}$/);
		const relay = io();
		expect(await runRemoteCli(["link", "--relay", "ws://127.0.0.1:1", "--no-qr"], env, relay)).toBe(0);
		expect(relay.lines[0]).toMatch(/http:\/\/127\.0\.0\.1:1\/#k=/);
		expect(await runRemoteCli(["stop"], env, io())).toBe(0);
		const after = io();
		await runRemoteCli(["list", "--json"], env, after);
		expect(JSON.parse(after.lines[0]).remote.links).toEqual([]);
		const bad = io();
		expect(await runRemoteCli(["link", "--relay"], env, bad)).toBe(1);
		expect(bad.errors[0]).toMatch(/--relay needs/);
	});

	it("says when no daemon runs and prints usage for anything else", async () => {
		const { env } = isolatedEnv();
		const none = io();
		expect(await runRemoteCli(["list"], env, none)).toBe(2);
		expect(none.errors[0]).toMatch(/No web daemon is running/);
		const usage = io();
		expect(await runRemoteCli(["frobnicate"], env, usage)).toBe(1);
		expect(usage.errors[0]).toMatch(/^Usage: octocode remote/);
		expect(await runRemoteCli([], env, usage)).toBe(1);
		expect(await runRemoteCli(["--help"], env, usage)).toBe(0);
	});
});

import type { ApplicationFrame } from "@octocodeai/octocode-contracts";
import { clearSecretValues } from "@octocodeai/octocode-common/sanitize";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { registerRemoteAutoStart, remoteCommand, type RemoteHost } from "../../src/octocode/remote/command.ts";
import { remoteSessionRow, remoteSessionsText, runRemoteCli } from "../../src/octocode/remote/cli.ts";
import { registerWebNotices } from "../../src/octocode/ui/web-notices.ts";
import { AttachClient } from "../../src/octocode/web-daemon/attach-client.ts";
import { startAttachServer } from "../../src/octocode/web-daemon/attach-server.ts";
import { attachRecordPath, webDaemonPaths } from "../../src/octocode/web-daemon/paths.ts";
import { readAttachRecord, writeDaemonRecord } from "../../src/octocode/web-daemon/records.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { fakeSession, isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	clearSecretValues();
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
		// A read-only link asks too: declining publishes nothing.
		await command.handler("view", ctx);
		expect(ctx.ui.notes.at(-1)).toEqual({ message: "Cancelled: nothing was published.", type: "info" });
		await command.handler("status", ctx);
		expect(ctx.ui.notes.at(-1)!.message).not.toContain("view link");
		ctx.ui.confirms.push(true);
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
		// Nobody can agree to a view link either: refused, nothing published.
		await command.handler("view", headless);
		expect(headless.ui.notes.at(-1)).toEqual({
			message: expect.stringContaining("octocode remote link view"),
			type: "warning",
		});
		expect(headless.ui.notes.at(-1)!.message).not.toContain("http://");
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
		ctx.ui.confirms.push(true);
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
		// Contract change: the JSON names the daemon it read (`null` when none runs), so a script can tell no daemon from no
		// session and stop it by pid.
		expect(JSON.parse(first.lines[0])).toEqual({
			daemon: { pid: process.pid, port: server.port },
			sessions: [],
			unavailable: [],
			remote: { links: [] },
		});
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

	it("prints each session's light in the words every surface uses, failed and compacting included", () => {
		const session = { id: "s1", repoId: "r", repoName: "demo", cwd: "/w", startedAt: 1, attached: true };
		const failed = { ...session, busy: false, activity: { tone: "error", state: "failed", label: "failed" } as const };
		expect(remoteSessionRow(failed)).toBe("failed\ts1\tdemo\t/w");
		const compacting = {
			...session,
			busy: false,
			activity: { tone: "working", state: "running", label: "compacting" } as const,
		};
		expect(remoteSessionRow(compacting)).toBe("compacting\ts1\tdemo\t/w");
		// A daemon that has not seen the state yet, or an older one, sends no light: the row reads busy and needsYou.
		expect(remoteSessionRow({ ...session, busy: true, needsYou: "Run it?" })).toBe("needs you\ts1\tdemo\t/w\tRun it?");
		expect(remoteSessionRow({ ...session, busy: true })).toBe("working\ts1\tdemo\t/w");
		expect(remoteSessionRow(session)).toBe("idle\ts1\tdemo\t/w");
		// The text listing names its columns once, above the rows.
		expect(remoteSessionsText([failed, { ...session, needsYou: "Run it?" }])).toBe(
			"ACTIVITY\tSESSION\tREPOSITORY\tFOLDER\tDIALOG\nfailed\ts1\tdemo\t/w\nneeds you\ts1\tdemo\t/w\tRun it?",
		);
		expect(remoteSessionsText([])).toBe("No sessions are attached to the web daemon.");
	});

	it("says when no daemon runs and prints usage for anything else", async () => {
		const { env } = isolatedEnv();
		const none = io();
		expect(await runRemoteCli(["list"], env, none)).toBe(2);
		expect(none.errors[0]).toMatch(/No web daemon is running/);
		expect(none.lines).toEqual([]);
		// A script that asked for JSON gets JSON on stdout, with the same exit status.
		const json = io();
		expect(await runRemoteCli(["list", "--json"], env, json)).toBe(2);
		expect(JSON.parse(json.lines[0])).toEqual({ daemon: null, sessions: [], unavailable: [], remote: { links: [] } });
		expect(json.errors[0]).toMatch(/No web daemon is running/);
		const usage = io();
		expect(await runRemoteCli(["frobnicate"], env, usage)).toBe(1);
		expect(usage.errors[0]).toMatch(/^Usage: octocode remote/);
		expect(await runRemoteCli([], env, usage)).toBe(1);
		expect(await runRemoteCli(["--help"], env, usage)).toBe(0);
	});
});

describe("a published link in the session's notices", () => {
	it("shows in the terminal and reaches the daemon's pages redacted, so a view link never reads a control link", async () => {
		const { server, origin, token } = await daemon();
		const sessionId = "session-test";
		const port = getApplicationPort({
			sessionId,
			messages: [],
			isStreaming: false,
			subscribe: () => () => undefined,
		} as unknown as AgentSession);
		cleanup.push(() => port.dispose());
		const fake = fakeHost();
		registerWebNotices(fake.api);
		const { env } = isolatedEnv();
		const attach = await startAttachServer(
			{
				sessionId,
				cwd: "/x",
				repo: { key: "/x/.git", name: "x", root: "/x" },
				workspace: { ...fakeSession(sessionId).workspace, application: port },
			},
			env,
		);
		cleanup.push(() => attach.close());
		const client = await AttachClient.connect(readAttachRecord(attachRecordPath(env, sessionId))!);
		cleanup.push(() => client.close());
		const frames = client.application.connect({ sessionId })[Symbol.asyncIterator]();
		expect((await frames.next()).value).toMatchObject({ type: "snapshot" });

		const ctx = fakeCtx({ cwd: "/x" });
		ctx.ui.confirms.push(true);
		await remoteCommand(host(async () => ({ origin, token }))).handler("", ctx);
		const said = ctx.ui.notes.at(-1)!.message;
		expect(said).toContain(`#access=${server.remoteToken}`);
		// What the terminal said goes to every page following the session (`ui_notice`), a view link's included.
		await fake.emit("ui_notice", { message: said, level: "info" }, ctx);
		const sent = JSON.stringify((await frames.next()).value as ApplicationFrame);
		expect(sent).toContain("session.activity");
		expect(sent).not.toContain(server.remoteToken);
		expect(sent).toContain("#access=[redacted]");
	});
});

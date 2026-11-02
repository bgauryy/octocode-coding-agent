import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import { processAlive } from "../src/octocode/shared/process.ts";
import { agentText, choose, startAcpAgent, type AcpAgent } from "./helpers/feature-host-acp.ts";
import {
	createSandbox,
	observeSessions,
	type ModelServer,
	type Sandbox,
	type SessionObserver,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

/**
 * What a session does under its canonical identity on `session/new` and `session/load`: autonomous work, a dialog the
 * client cannot show, and a permission prompt the client allows, cancels, answers as cancelled, or abandons by closing
 * the session or the connection. The producers are native: a prompt, the `askUser` tool, and a manual-mode shell call.
 */
let sandbox: Sandbox;
let server: ModelServer | undefined;
let agent: AcpAgent | undefined;
let sessions: SessionObserver | undefined;

afterEach(async () => {
	await agent?.stop();
	// The agent process exiting does not end the session workers it started: a worker closing its session still writes
	// into the sandbox (database, session files). Remove the folder only after every one of them is gone.
	if (sessions)
		await vi.waitFor(() => expect(sessions?.started().filter(processAlive)).toEqual([]), { timeout: 30_000 });
	await server?.close();
	sandbox?.cleanup();
	agent = undefined;
	server = undefined;
	sessions = undefined;
}, 60_000);

const shell = (file: string) => ({ tool: "bash", args: { command: `echo ran > ${file}` } });
const ask = {
	tool: "askUser",
	args: { questions: [{ question: "Unsupported question?", options: [{ label: "One" }, { label: "Two" }] }] },
};

it.each(["work", "dialog", "permission", "cancel", "cancel-response", "close", "eof"])(
	"projects %s under its canonical identity on new and load",
	async (mode) => {
		sandbox = createSandbox({ OCTOCODE_PERMISSION: "manual" });
		sessions = observeSessions(sandbox);
		const observed = sessions;
		server = await startModelServer(
			mode === "work"
				? [{ text: "first answer" }, { text: "second answer" }]
				: mode === "dialog"
					? [ask, { text: "asked" }]
					: [shell("ran.txt"), { text: "finished" }, shell("ran-again.txt"), { text: "finished again" }],
		);
		writeScriptedProvider(sandbox, server);
		const permissions: string[] = [];
		agent = startAcpAgent(sandbox, {
			permission: async (params, current) => {
				permissions.push(params.sessionId);
				if (mode === "cancel") {
					await current.connection.agent.notify(methods.agent.session.cancel, { sessionId: params.sessionId });
					return { outcome: { outcome: "cancelled" } };
				}
				if (mode === "cancel-response") return { outcome: { outcome: "cancelled" } };
				if (mode === "close") {
					await current.connection.agent.request(methods.agent.session.close, { sessionId: params.sessionId });
					return { outcome: { outcome: "cancelled" } };
				}
				if (mode === "eof") {
					current.child.stdin.end();
					return { outcome: { outcome: "cancelled" } };
				}
				return choose(params, "allow_once");
			},
		});
		const current = agent;
		const ran = (file: string) => existsSync(join(sandbox.project, file));
		await current.initialize();
		const sessionId = await current.newSession();
		const first = current.prompt(sessionId, "first prompt");

		if (mode === "close" || mode === "eof") {
			await Promise.race([first.catch(() => undefined), current.exited]);
			expect(permissions).toEqual([sessionId]);
			expect(ran("ran.txt"), "the abandoned call never ran").toBe(false);
			if (mode === "eof") {
				await current.exited;
				await vi.waitFor(() => expect(observed.started().filter(processAlive)).toEqual([]), { timeout: 20_000 });
			}
			return;
		}
		if (mode === "cancel" || mode === "cancel-response") {
			// A client that answers "cancelled" ends the turn as cancelled, as one that sends `session/cancel` does.
			await expect(first, current.diagnostics()).resolves.toMatchObject({ stopReason: "cancelled" });
			expect(permissions).toEqual([sessionId]);
			expect(ran("ran.txt")).toBe(false);
			await expect(current.prompt(sessionId, "after cancellation")).resolves.toMatchObject({ stopReason: "end_turn" });
			return;
		}
		await expect(first, current.diagnostics()).resolves.toMatchObject({ stopReason: "end_turn" });
		if (mode === "work") expect(agentText(current.updates)).toContain("first answer");
		if (mode === "dialog")
			expect(JSON.stringify(server.requests.at(-1)), "the unanswerable dialog reached the model as declined").toContain(
				"Cancelled",
			);
		if (mode === "permission") {
			expect(permissions).toEqual([sessionId]);
			expect(ran("ran.txt")).toBe(true);
		}
		expect(current.updates.every((update) => update.sessionId === sessionId)).toBe(true);

		// Reopening the saved session replays its history under the same identity, and it still works.
		await current.connection.agent.request(methods.agent.session.close, { sessionId });
		current.updates.length = 0;
		await current.connection.agent.request(methods.agent.session.load, {
			cwd: sandbox.project,
			sessionId,
			mcpServers: [],
		});
		if (mode === "work") expect(agentText(current.updates)).toContain("first answer");
		expect(current.updates.length, "load replays the history").toBeGreaterThan(0);
		await expect(current.prompt(sessionId, "after load"), current.diagnostics()).resolves.toMatchObject({
			stopReason: "end_turn",
		});
		expect(current.updates.every((update) => update.sessionId === sessionId)).toBe(true);
		if (mode === "permission") {
			expect(permissions).toEqual([sessionId, sessionId]);
			expect(ran("ran-again.txt")).toBe(true);
		}
	},
	120_000,
);

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { methods } from "@agentclientprotocol/sdk";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createSessionControls } from "../src/modes/rpc/rpc-mode/session-controls.ts";
import { startAcpAgent, type AcpAgent } from "./helpers/feature-host-acp.ts";
import {
	createSandbox,
	observeSessions,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

const REFUSAL = "ACP owns session selection";

describe("session controls", () => {
	const runtime = () =>
		({
			newSession: vi.fn(async () => ({ cancelled: false })),
			switchSession: vi.fn(async () => ({ cancelled: false })),
			fork: vi.fn(async () => ({ cancelled: false })),
		}) as unknown as AgentSessionRuntime & Record<"newSession" | "switchSession" | "fork", ReturnType<typeof vi.fn>>;

	it.each(["newSession", "switchSession", "fork"] as const)(
		"refuses %s before replacing an ACP-owned session",
		async (operation) => {
			const host = runtime();
			await expect(
				(createSessionControls(host, true)[operation] as (...args: unknown[]) => Promise<unknown>)("x"),
			).rejects.toThrow(REFUSAL);
			expect(host[operation]).not.toHaveBeenCalled();
		},
	);

	it.each(["newSession", "switchSession", "fork"] as const)(
		"leaves %s to the runtime for plain RPC",
		async (operation) => {
			const host = runtime();
			await (createSessionControls(host, false)[operation] as (...args: unknown[]) => Promise<unknown>)("x");
			expect(host[operation]).toHaveBeenCalledTimes(1);
		},
	);
});

let sandbox: Sandbox;
let server: ModelServer | undefined;
let agent: AcpAgent | undefined;

afterEach(async () => {
	await agent?.stop();
	await server?.close();
	sandbox?.cleanup();
	agent = undefined;
	server = undefined;
});

/** `/worktree switch` is a native command that asks the host for a new session in another folder. */
it("refuses a native command's new session before replacing an ACP-owned session", async () => {
	sandbox = createSandbox();
	const sessions = observeSessions(sandbox);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], {
			cwd: sandbox.project,
			stdio: "ignore",
		});
	git("init", "-q");
	git("commit", "--allow-empty", "-q", "-m", "init");
	mkdirSync(join(sandbox.project, ".octocode", "worktrees"), { recursive: true });
	git("worktree", "add", "-q", "-b", "wt", join(".octocode", "worktrees", "wt"));
	server = await startModelServer([{ text: "before" }, { text: "after" }]);
	writeScriptedProvider(sandbox, server);
	agent = startAcpAgent(sandbox);
	await agent.initialize();
	const sessionId = await agent.newSession();
	await agent.prompt(sessionId, "before rotation");
	agent.updates.length = 0;
	// The command answers with a notice the ACP client does not display; the refusal itself is the unit test above.
	const modelRequests = server.requests.length;
	await agent.prompt(sessionId, "/worktree switch wt");
	expect(server.requests.length, "the command ran and was not sent to the model").toBe(modelRequests);
	expect(new Set(sessions.started()).size, "no second session started in the worker").toBe(1);
	await expect(agent.prompt(sessionId, "after refused rotation")).resolves.toMatchObject({ stopReason: "end_turn" });
	const listed = await agent.connection.agent.request(methods.agent.session.list, { cwd: sandbox.project });
	expect(listed.sessions.map((session) => session.sessionId)).toEqual([sessionId]);
}, 120_000);

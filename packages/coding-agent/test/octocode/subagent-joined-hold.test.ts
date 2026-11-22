import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { SessionManager } from "../../src/core/session-manager.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { registerNativeSessionLifecycle } from "../../src/octocode/session-lifecycle.ts";
import { registerWake } from "../../src/octocode/wake/register.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { testFeatures } from "../helpers/features.ts";
import { tmp } from "./helpers.ts";

const posix = process.platform !== "win32";
/** `OCTOCODE_TEST_EVENT_LOOP=new` runs these with the wake gate and the live event loop installed, as a session is. */
const eventLoop = process.env.OCTOCODE_TEST_EVENT_LOOP as "shadow" | "new" | undefined;

/** A subagent session with the real bash tool, the native run-end hold, and a handle on its Stop signal. */
async function child(options: { jobHoldMs?: number } = {}) {
	const root = tmp();
	const jobs = new BashJobs(tmp());
	const stop = new AbortController();
	const harness = await createHarness({
		sessionManager: SessionManager.create(root, path.join(root, "sessions")),
		...(eventLoop ? { settings: { runtime: { eventLoop } } } : {}),
		features: testFeatures([
			(api) => {
				if (eventLoop) registerWake(api);
				registerBashTool(api, new Subcommands(), jobs, () => ({ backgroundAfterSeconds: 0 }));
				registerNativeSessionLifecycle(api, {
					isSubagent: true,
					team: { interrupted: stop.signal, id: "child" } as never,
					permission: { shutdown: () => undefined } as never,
					jobs,
					...options,
				});
			},
		]),
	});
	await harness.session.bindFeatures({});
	return { harness, jobs, stop };
}

/** Another Octocode session in the child's folder that starts the build the child then asks for too. */
function owner(cwd: string) {
	const { api, tools } = fakeHost();
	const jobs = new BashJobs(tmp());
	registerBashTool(api, new Subcommands(), jobs, () => ({}));
	const ctx = fakeCtx({ cwd });
	ctx.sessionManager.getSessionId = () => "s-owner";
	return {
		jobs,
		start: (command: string) =>
			tools.get("bash").execute("t", { reason: "Build.", command, background: true }, undefined, undefined, ctx),
	};
}

const requestText = (context: { messages: Parameters<typeof getMessageText>[0][] }) =>
	context.messages.map((message) => getMessageText(message)).join("\n");

describe.runIf(posix)("a subagent that joined another session's running job and answers while it runs (B89)", () => {
	const open: Array<{ harness: Harness; jobs: BashJobs }> = [];
	const owners: BashJobs[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const { harness, jobs } of open.splice(0)) {
			await jobs.stopAll("session end");
			harness.cleanup();
		}
		for (const jobs of owners.splice(0)) await jobs.stopAll("session end");
	});

	const COMMAND = "sleep 2; echo build-finished-marker";
	const joinCall = () =>
		fauxAssistantMessage([fauxToolCall("bash", { command: COMMAND, background: true, reason: "build" })], {
			stopReason: "toolUse",
		});

	it("holds its run until the joined job ends, then wakes for another turn and reports", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const session = await child();
		open.push(session);
		const other = owner(session.harness.tempDir);
		owners.push(other.jobs);
		await other.start(COMMAND);
		let last = "";
		session.harness.setResponses([
			joinCall(),
			fauxAssistantMessage("Waiting for the build"),
			(context) => {
				last = requestText(context);
				return fauxAssistantMessage("done. The build printed its marker.");
			},
		]);
		await session.harness.session.prompt("build and report");
		expect(session.harness.faux.state.callCount).toBe(3);
		expect(last).toContain("You joined this job");
	});

	it("ends at once when Stop arrives while it idles on the joined job", async () => {
		vi.stubEnv(SUBAGENT_ENV, "1");
		const session = await child();
		open.push(session);
		const other = owner(session.harness.tempDir);
		owners.push(other.jobs);
		await other.start("sleep 30");
		session.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", background: true, reason: "build" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Waiting for the build"),
		]);
		const started = Date.now();
		const run = session.harness.session.prompt("build and report");
		setTimeout(() => session.stop.abort(), 1_000);
		await run;
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(session.harness.faux.state.callCount).toBe(2);
	});
});

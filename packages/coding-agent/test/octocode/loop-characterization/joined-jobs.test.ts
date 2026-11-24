import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BashJobs } from "../../../src/octocode/files/bash-jobs.ts";
import { registerBashTool } from "../../../src/octocode/native/tools/bash/tool.ts";
import { Subcommands } from "../../../src/octocode/shared/commands.ts";
import { JOB_TYPE } from "../../../src/octocode/shared/messages.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";
import { tmp } from "../helpers.ts";
import { restoreBacklogEnv } from "./backlog-rig.ts";
import { count, createRig, quiet, type Rig } from "./rig.ts";

/**
 * A joined background job (native/tools/bash/background-joins.ts): the session that starts an identical command another live
 * session already runs joins it, and the other's end wakes it through the gate like a job of its own (RFC agent-event-loop
 * R0, §4). R6 moves the producer to `job.exit`; one turn per joined end, carrying "You joined this job", must stay.
 */

const rigs: Rig[] = [];
const owners: BashJobs[] = [];
const saved = process.env.OCTOCODE_AGENT_DB;
afterEach(() => {
	for (const jobs of owners.splice(0)) for (const id of jobs.jobs.keys()) jobs.stop(id, "user");
	for (const rig of rigs.splice(0)) rig.cleanup();
	restoreBacklogEnv();
	if (saved !== undefined) process.env.OCTOCODE_AGENT_DB = saved;
});

const bashCall = (command: string) =>
	fauxAssistantMessage(fauxToolCall("bash", { command, background: true, reason: "characterize" }), {
		stopReason: "toolUse",
	});

/** The rig's session and a second session (the owner) share one database and folder; the owner starts the job. */
async function pair() {
	process.env.OCTOCODE_AGENT_DB = path.join(tmp(), "octocode.db");
	const joinerJobs = new BashJobs(tmp());
	const rig = await createRig({ register: (api) => void registerBashTool(api, new Subcommands(), joinerJobs) });
	rigs.push(rig);
	const host = fakeHost();
	const ownerJobs = new BashJobs(tmp());
	owners.push(ownerJobs, joinerJobs);
	registerBashTool(host.api, new Subcommands(), ownerJobs, () => ({}));
	const ctx = fakeCtx({ cwd: rig.ctx.cwd });
	ctx.sessionManager.getSessionId = () => "owner-session";
	const start = (command: string) =>
		host.tools.get("bash").execute("t", { reason: "Run it.", command, background: true }, undefined, undefined, ctx);
	return { rig, joinerJobs, ownerJobs, start };
}

const jobMessages = (rig: Rig) =>
	rig.harness.session.messages.filter((message) => message.role === "custom" && message.customType === JOB_TYPE);

describe.runIf(process.platform !== "win32")("a joined background job's end", () => {
	it("wakes the idle joiner with one turn naming the job it joined, and the joiner owns nothing to stop", async () => {
		const { rig, joinerJobs, ownerJobs, start } = await pair();
		await start("sleep 30");
		rig.harness.setResponses([bashCall("sleep 30"), fauxAssistantMessage("joined"), rig.reply("woken by the join")]);
		await rig.harness.session.prompt("run it");
		await rig.harness.session.waitForIdle();
		expect(joinerJobs.jobs.size).toBe(0);
		expect(rig.requests).toHaveLength(0);
		// The joiner watches the owner's job (its log, its process), and waits for that job's end.
		const owned = ownerJobs.jobs.get("bash-1")!;
		const [watched] = [...joinerJobs.joined.values()];
		expect(watched).toMatchObject({ id: "bash-1", pid: owned.pid, log: owned.log });
		expect(ownerJobs.stop("bash-1", "user")).toBe(true);
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 15_000 });
		await rig.harness.session.waitForIdle();
		// The turn carries one report, of the job the joiner did not start: the owner's command and the owner's log.
		expect(count(rig.requests[0], "Background bash bash-1")).toBe(1);
		expect(jobMessages(rig)).toHaveLength(1);
		expect(jobMessages(rig)[0]).toMatchObject({
			details: { id: "bash-1", command: "sleep 30", log: owned.log, interrupted: true, ok: false },
		});
		// One end, one wake: the joined job reported its end and the joiner watches nothing more.
		await watched.done;
		expect(joinerJobs.joined.size).toBe(0);
		await quiet(rig);
		expect(rig.requests).toHaveLength(1);
		expect(jobMessages(rig)).toHaveLength(1);
	}, 40_000);

	it("a job that ends by itself wakes the joiner as finished (exit 0)", async () => {
		const { rig, start } = await pair();
		await start("sleep 3");
		rig.harness.setResponses([bashCall("sleep 3"), fauxAssistantMessage("joined"), rig.reply("it finished")]);
		await rig.harness.session.prompt("run it");
		await vi.waitFor(() => expect(rig.requests).toHaveLength(1), { timeout: 20_000 });
		await rig.harness.session.waitForIdle();
		expect(count(rig.requests[0], "[exit 0")).toBe(1);
		expect(jobMessages(rig)[0]).toMatchObject({ details: { id: "bash-1", ok: true } });
	}, 40_000);
});

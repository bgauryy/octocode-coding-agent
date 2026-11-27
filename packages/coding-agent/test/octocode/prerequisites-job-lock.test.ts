import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { itemMarks } from "../../src/octocode/backlog/marks.ts";
import { getItem } from "../../src/octocode/backlog/reads.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { ChainQueue, openPrerequisites, type AfterHost } from "../../src/octocode/subagents/chain.ts";
import { parsePrerequisite, PrerequisiteGate, type GateHost } from "../../src/octocode/subagents/prerequisites.ts";
import { unlockedSpec } from "../../src/octocode/timer/conditions/unlocked.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** RFC V4: `job:` and `lock:` prerequisites, the `unlocked full-run` wait and the board's `blocked by bash-N`. */

const lock = vi.hoisted(() => ({ holder: undefined as undefined | Record<string, string> }));
vi.mock("../../src/octocode/graph/run-lock.ts", () => ({ readRunLockSnap: () => lock.holder }));
afterEach(() => {
	lock.holder = undefined;
	closeSharedAgentDb();
});

type Standing = ReturnType<NonNullable<GateHost["job"]>>;
function gateOf(jobs: Record<string, Standing> = {}) {
	let poke: (() => void) | undefined;
	let watching = 0;
	const host: GateHost = {
		item: () => "missing",
		lifecycle: () => () => undefined,
		follow: (next) => {
			poke = next;
			return () => undefined;
		},
		job: (id) => jobs[id] ?? { state: "missing" },
		lockHeld: () => lock.holder !== undefined,
		watchLocks: () => {
			watching++;
			return () => void watching--;
		},
	};
	return { gate: new PrerequisiteGate(host), jobs, moved: () => poke?.(), watching: () => watching };
}
const after = (): AfterHost => ({ item: () => ({ standing: "missing", dependsOn: [] }), liveChild: () => false });
const signal = () => new AbortController().signal;

describe("job: and lock: prerequisites", () => {
	it("parses only job ids of this kind and the named lock", () => {
		expect(parsePrerequisite("job:bash-3")).toEqual({ kind: "job", id: "bash-3" });
		expect(parsePrerequisite("lock:full-run")).toEqual({ kind: "lock", name: "full-run" });
		expect(parsePrerequisite("job:x")).toBeUndefined();
		expect(parsePrerequisite("lock:other")).toBeUndefined();
	});

	it("waits for a job to exit 0, and fails the wait when it fails or is not a job of the session", async () => {
		const s = gateOf({ "bash-3": { state: "running" }, "bash-4": { state: "running" } });
		const ok = s.gate.wait([{ kind: "job", id: "bash-3" }], signal());
		const bad = s.gate.wait([{ kind: "job", id: "bash-4" }], signal());
		s.jobs["bash-3"] = { state: "done" };
		s.jobs["bash-4"] = { state: "failed", why: "exited 1" };
		s.moved();
		await expect(ok).resolves.toMatchObject({ status: "met" });
		await expect(bad).resolves.toEqual({
			status: "failed",
			failed: [{ name: "job:bash-4", why: "bash-4 exited 1" }],
		});
		const queue = new ChainQueue(s.gate, () => undefined);
		expect(() => openPrerequisites(after(), queue, ["job:bash-9"], undefined, [])).toThrow(
			/job:bash-9.*not a background job/,
		);
		expect(openPrerequisites(after(), queue, ["job:bash-3"], undefined, [])).toEqual([]);
	});

	it("waits for the full-run lock to be free, watching it only while a wait needs it", async () => {
		lock.holder = { label: "yarn run check", agent: "swift-orca", item: "B915", job: "bash-1" };
		const s = gateOf();
		const queue = new ChainQueue(s.gate, () => undefined);
		expect(openPrerequisites(after(), queue, ["lock:full-run"], undefined, [])).toEqual([
			{ kind: "lock", name: "full-run" },
		]);
		const result = s.gate.wait([{ kind: "lock", name: "full-run" }], signal());
		expect(s.watching()).toBe(1);
		lock.holder = undefined;
		s.moved();
		await expect(result).resolves.toMatchObject({ status: "met" });
		expect(s.watching()).toBe(0);
	});
});

describe("wait until unlocked full-run", () => {
	const check = () => unlockedSpec.check({ kind: "unlocked", path: "full-run" }, { cwd: tmp(), deps: {} as never });

	it("is met when nobody holds the lock and says who holds it otherwise", async () => {
		expect(await check()).toMatchObject({ met: true });
		lock.holder = { label: "yarn run check", agent: "swift-orca", item: "B915", job: "bash-1" };
		const held = await check();
		expect(held.met).toBe(false);
		expect(held.output).toBe("The full-run lock is held by yarn run check (agent swift-orca, item B915, job bash-1).");
		expect(unlockedSpec.describe({ kind: "unlocked", path: "full-run" })).toBe("the full-run lock free");
	});
});

describe.runIf(process.platform !== "win32")("the board's blocked mark", () => {
	it("names a running background job of the item: blocked by bash-N", async () => {
		const { api, tools } = fakeHost();
		const jobs = new BashJobs(tmp());
		registerBashTool(api, new Subcommands(), jobs, () => ({}));
		const ctx = fakeCtx({ cwd: tmp() });
		const { store } = openBacklog(ctx, { isSubagent: false });
		const added = store.add({ title: "Checked", goal: "g", why: "w", state: "todo", createdBy: "user" });
		await tools
			.get("bash")
			.execute(
				"t",
				{ command: "sleep 30", background: true, item: added.ref, reason: "Check." },
				undefined,
				undefined,
				ctx,
			);
		const { agent, workspace } = workspaceDb(ctx.cwd);
		const repo = workspace.id;
		const marks = () => itemMarks(agent.db, repo, [getItem(agent.db, repo, added.ref)!]).get(added.ref);
		expect(marks()?.blockedBy).toEqual(["bash-1"]);
		jobs.stop("bash-1", "user");
		await vi.waitFor(() => expect(marks()?.blockedBy).toBeUndefined());
	});
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { runBacklogCommand } from "../../src/cli/backlog-command.ts";
import { groomReport, groomText } from "../../src/octocode/backlog/groom.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";

const DAY = 86_400_000;
const HUMAN = { id: "human", surface: "command" as const };
const READY = { goal: "Observable result", why: "Needed", createdBy: "agent" as const };

let root: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let now: number;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-groom-")));
	repo = path.join(root, "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo, "src"));
	fs.writeFileSync(path.join(repo, "src", "kept.ts"), "");
	env = { ...process.env, OCTOCODE_HOME: path.join(root, "home"), OCTOCODE_AGENT_DB: path.join(root, "agent.db") };
	vi.stubEnv("OCTOCODE_HOME", env.OCTOCODE_HOME);
	vi.stubEnv("OCTOCODE_AGENT_DB", env.OCTOCODE_AGENT_DB);
	now = Date.now();
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const board = (clock = () => now) =>
	new BacklogStore(() => sharedAgentDb(env), registeredWorkspace(repo, sharedAgentDb(env)).id, clock);

describe("backlog groom: grooming's mechanical checks run as code", () => {
	it("flags finished epics, gone paths, duplicates, blocked and idle items, and leaves sound items out", async () => {
		const old = board(() => now - 30 * DAY);
		const stale = old.add({ ...READY, title: "Prune unused footer helpers", state: "backlog" });
		const store = board();
		const epic = store.add({ ...READY, title: "Footer epic", type: "epic", state: "todo" });
		const child = store.add({ ...READY, title: "Footer child", parentId: epic.ref, state: "todo" });
		store.update(
			child.ref,
			{
				state: "done",
				completion: {
					summary: "Shipped",
					files: [],
					verification: { status: "passed", summary: "Unit tests passed" },
					operationKey: "done",
				},
			},
			HUMAN,
		);
		store.add({ ...READY, title: "Empty plan epic", type: "epic", state: "todo" });
		const gone = store.add({ ...READY, title: "Fix removed module", paths: ["src/removed.ts"] });
		const kept = store.add({ ...READY, title: "Fix kept module", paths: ["src/kept.ts", "src/removed.ts"] });
		const first = store.add({ ...READY, title: "Web daemon drains stale page builds" });
		const second = store.add({ ...READY, title: "Drain stale web daemon page builds" });
		const waiting = store.add({ ...READY, title: "Run the eval", dependsOn: [gone.ref] });

		const report = groomReport(store, repo, now);
		const refs = (key: keyof Omit<typeof report, "open">) => report[key].map((row) => row.ref);
		expect(refs("epicsToClose")).toEqual([epic.ref]);
		expect(refs("pathsGone")).toEqual([gone.ref]);
		expect(refs("pathsGone")).not.toContain(kept.ref);
		// One row per pair, beside whichever comes first on the board; similar but distinct titles do not pair.
		expect(report.duplicates).toHaveLength(1);
		const [row] = report.duplicates;
		expect([row.ref, row.detail.split(" ")[2]].toSorted()).toEqual([first.ref, second.ref].toSorted());
		expect(refs("blocked")).toEqual([waiting.ref]);
		expect(refs("idle")).toEqual([stale.ref]);
		expect(report.stale).toEqual([]);
		expect(report.releasable).toEqual([]);

		const text = groomText(report);
		expect(text).toContain(`- ${epic.ref} Footer epic: every item finished`);
		expect(text).not.toContain("Claims");
	});

	it("prints the report through `octocode backlog groom` and changes nothing", async () => {
		const store = board();
		store.add({ ...READY, title: "Sound item", state: "todo" });
		const before = store.list({ states: ["backlog", "todo", "ongoing", "done", "closed"] }).items;
		const out: string[] = [];
		const err: string[] = [];
		const code = await runBacklogCommand(["groom"], {
			cwd: repo,
			env,
			out: (t) => out.push(t),
			err: (t) => err.push(t),
		});
		expect([code, err]).toEqual([0, []]);
		expect(out.join("\n")).toBe("Groom: 1 open items checked by code; judge only the rows below.\n\nNothing flagged.");
		expect(store.list({ states: ["backlog", "todo", "ongoing", "done", "closed"] }).items).toEqual(before);
		expect(await runBacklogCommand(["groom", "extra"], { cwd: repo, env, out: () => {}, err: () => {} })).toBe(1);
	});
});

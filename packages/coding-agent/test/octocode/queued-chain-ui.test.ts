import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChainQueue } from "../../src/octocode/subagents/chain.ts";
import { PrerequisiteGate } from "../../src/octocode/subagents/prerequisites.ts";
import { backgroundSummary } from "../../src/octocode/subagents/background-summary.ts";
import { queuedItems } from "../../src/octocode/shared/queued-items.ts";
import { RunningWork, workCounts } from "../../src/octocode/shared/running-work.ts";
import { AgentsView } from "../../src/octocode/team/panel.ts";
import { workRows } from "../../src/octocode/team/panel/work.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const MARKS = { live: "●", waiting: "◇" };
const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

const queue = () =>
	new ChainQueue(
		new PrerequisiteGate({ item: () => "open", lifecycle: () => () => undefined, follow: () => () => undefined }),
		() => undefined,
	);
const queued = (chain: ChainQueue, id: string, after: string[], item?: string) =>
	chain.add({ id, role: "worker", goal: "g", after, ...(item ? { item } : {}), release: () => undefined });

describe("queued and held children in the UI", () => {
	it("draws the queued row with its prerequisite and owner, and the held row with its reason", () => {
		const chain = queue();
		queued(chain, "nimble-kelp", ["B12"], "B14");
		queued(chain, "calm-fern", ["B12"]);
		chain.hold("calm-fern", "B12 failed", ["B12"]);
		const rows = chain.work(new Map([["sly-mantle", "B12"]]));
		expect(rows.map((row) => row.title)).toEqual(["queued · after B12 (sly-mantle)", "held · B12 failed"]);
		const lines = workRows(
			rows.map((row) => ({
				kind: "agent" as const,
				id: row.id,
				title: row.title,
				mark: row.held ? ("held" as const) : ("queued" as const),
			})),
			0,
			theme,
			80,
			MARKS,
		).map(plain);
		expect(lines[0]).toContain("◷");
		expect(lines[0]).toMatch(/nimble-kelp +queued · after B12 \(sly-mantle\)/);
		expect(lines[1]).toContain("⏸");
		expect(lines[1]).toMatch(/calm-fern +held · B12 failed/);
	});

	it("counts queued children apart from agents in the footer, and drops a started child from the rows", () => {
		expect(workCounts(1, [], 2)).toBe("🐙 1 agent · 2 queued");
		expect(workCounts(0, [], 0)).toBe("");
		const chain = queue();
		queued(chain, "a-1", ["B1"], "B2");
		expect(chain.size).toBe(1);
		expect(queuedItems().get("B2")).toBe("a-1");
		chain.markStarted("a-1");
		expect(chain.size).toBe(0);
		expect(chain.rows()).toEqual([]);
		expect(queuedItems().has("B2")).toBe(false);
	});

	it("shows queued rows in the panel and `N queued` in the running status; a started child counts as an agent", () => {
		const f = fakeHost();
		const team = new Team(f.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "none", "team.sqlite") });
		const ctx = fakeCtx({ cwd: tmp() });
		team.start(ctx);
		const work = new RunningWork();
		const view = new AgentsView(team, work);
		view.start(ctx);
		view.setBackground(["a-1", "b-2"]);
		view.setQueued([{ id: "b-2", title: "queued · after B1", held: false }]);
		expect(ctx.ui.statuses.get("octocode-running")).toBe("🐙 1 agent · 1 queued");
		view.setQueued([{ id: "b-2", title: "held · B1 failed", held: true }]);
		expect(ctx.ui.statuses.get("octocode-running")).toBe("🐙 1 agent · 1 queued");
		view.setQueued([]);
		expect(ctx.ui.statuses.get("octocode-running")).toBe("🐙 2 agents");
		view.stop(ctx);
		team.stop();
	});

	it("words the transcript row: queued, held, started after", () => {
		const base = { id: "kelp-1" } as never;
		expect(backgroundSummary({ ...(base as object), queued: true, after: ["B12"] } as never)).toBe(
			"Queued · starts after B12 as kelp-1",
		);
		expect(backgroundSummary({ ...(base as object), queued: true, after: ["B12"], held: "B12 failed" } as never)).toBe(
			"Queued · held: B12 failed as kelp-1",
		);
		expect(backgroundSummary({ ...(base as object), startedAfter: ["B12"] } as never)).toBe(
			"Started after B12 as kelp-1",
		);
		expect(backgroundSummary(base)).toBe("Running in the background as kelp-1");
	});
});

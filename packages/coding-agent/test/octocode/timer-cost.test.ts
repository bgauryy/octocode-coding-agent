import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, openDatabase, timers } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { createExtensionRuntime } from "../helpers/features.ts";
import { ExtensionRunner } from "../../src/core/features/runner.ts";
import type { ExtensionActions, ExtensionContext, ExtensionContextActions } from "../../src/core/features/types.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { addUsageToTotals, createUsageTotals, entryUsage } from "../../src/core/usage-totals.ts";
import { Judge } from "../../src/octocode/timer/judge.ts";
import { wakeDetails } from "../../src/octocode/timer/model.ts";
import { callSmallModel, smallModelLabel } from "../../src/octocode/subagents/small-call.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { tmp } from "./helpers.ts";

const COST = 0.004;
let root: string;
let agent: AgentDb;
let workspaceId: string;

beforeEach(() => {
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	workspaceId = registeredWorkspace(root, agent).id;
});
afterEach(() => agent.close());

const model = (id: string, input: number) => ({
	provider: "p",
	id,
	api: "faux",
	cost: { input, output: input, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	input: ["text"],
});

/** A judge whose recordUsage is the real runtime port bound to a real session manager. */
async function session(reply: string) {
	const sessionManager = SessionManager.inMemory();
	const runtime = createExtensionRuntime();
	const runner = new ExtensionRunner(
		[],
		runtime,
		root,
		sessionManager,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	runner.bindCore({} as ExtensionActions, {} as ExtensionContextActions);
	const parent = model("big", 15);
	const ctx = {
		model: parent,
		modelRegistry: {
			getAvailable: () => [parent, model("cheap", 1)],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		},
	} as unknown as ExtensionContext;
	const complete = vi.fn(async () => {
		const message = fauxAssistantMessage(reply);
		message.usage = { ...message.usage, cost: { ...message.usage.cost, total: COST } };
		return message;
	});
	const judge = new Judge({
		ctx: () => ctx,
		now: () => Date.now(),
		sessionSpend: () => 0,
		allowed: () => true,
		recordUsage: runtime.recordUsage,
		small: { call: (c, options) => callSmallModel(c, { ...options, complete }), label: smallModelLabel },
	});
	const total = () => {
		const totals = createUsageTotals();
		for (const entry of sessionManager.getEntries()) {
			const spend = entryUsage(entry);
			if (spend) addUsageToTotals(totals, spend.usage);
		}
		return totals.cost;
	};
	return { sessionManager, judge, total };
}

const ask = { id: 1, sessionId: "s1", question: "done?", trigger: "x changed", evidence: "e", checks: 0, spentUsd: 0 };

describe("a timer check's spend in the session cost total", () => {
	it("counts a cancelled wait's check exactly once", async () => {
		const { judge, total } = await session('{"verdict":"not_met","reason":"no"}');
		const row = timers.insert(agent.db, {
			sessionId: "s1",
			workspaceId,
			kind: "once",
			note: "n",
			dueAt: Date.now() + 60_000,
			at: Date.now(),
		});
		const outcome = await judge.judge(ask);
		expect(outcome.verdict).toBe("not_met");
		timers.cancel(agent.db, row.id, "s1", Date.now());
		expect(total()).toBeCloseTo(COST, 9);
	});

	it("counts a fired wait's check exactly once, the wake message carrying no usage", async () => {
		const { judge, total, sessionManager } = await session('{"verdict":"met","reason":"yes"}');
		const outcome = await judge.judge(ask);
		expect(outcome.verdict).toBe("met");
		const details = wakeDetails({
			id: 1,
			kind: "until",
			status: "done",
			note: "n",
			runs: 1,
			max_runs: null,
			last_exit: null,
			last_output: null,
			condition_kind: "check",
			checks: 1,
			spent_usd: COST,
			stop_reason: "met",
		} as never);
		sessionManager.appendCustomMessageEntry("timer", "fired", true, details);
		expect(total()).toBeCloseTo(COST, 9);
	});
});

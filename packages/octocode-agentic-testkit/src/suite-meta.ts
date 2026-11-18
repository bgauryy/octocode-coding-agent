import { wilson } from "./live.ts";
import type { MockMcp } from "./mcp.ts";
import { skillLoads } from "./matchers/skills.ts";
import { spentUsd } from "./policy.ts";
import { guardReason, type Trace } from "./trace.ts";

/** What one suite test did across its runs; stored on `task.meta.agentSuite` for reporters. */
export interface SuiteMeta {
	adapter: string;
	runs: number;
	passes: number;
	needed: number;
	/** 95% Wilson interval of the pass rate. */
	interval: [number, number];
	/** USD of the priced requests in this test, all runs (0 without `pricing`). */
	costUsd: number;
	requests: number;
	failures: { replica: number; message: string }[];
	/** `server.tool` for every tool the mock servers advertise. */
	toolsAdvertised: string[];
	/** `server.tool` the mock servers executed in this test. */
	toolsExecuted: string[];
	/** Tool names the model asked for in this test, as it named them. */
	modelTools: string[];
	skills: string[];
	/** Reasons of every guard that fired in this test. */
	guards: string[];
	/** Tool sequence per run, in call order. */
	trajectories: string[][];
}

declare module "vitest" {
	interface TaskMeta {
		agentSuite?: SuiteMeta;
	}
}

const uniq = (xs: string[]): string[] => [...new Set(xs)].toSorted();

/** Builds the meta of one test from each run's turn views (`Trace.since`). */
export function suiteMeta(o: {
	adapter: string;
	needed: number;
	passes: number;
	failures: SuiteMeta["failures"];
	turns: Trace[];
	mcp: Record<string, MockMcp>[];
}): SuiteMeta {
	const events = o.turns.flatMap((t) => t.events);
	return {
		adapter: o.adapter,
		runs: o.turns.length,
		passes: o.passes,
		needed: o.needed,
		interval: wilson(o.passes, o.turns.length),
		costUsd: o.turns.reduce((n, t) => n + spentUsd(t), 0),
		requests: o.turns.reduce((n, t) => n + t.requests.length, 0),
		failures: o.failures.toSorted((a, b) => a.replica - b.replica),
		toolsAdvertised: uniq(Object.values(o.mcp[0] ?? {}).flatMap((m) => m.defs.map((d) => `${m.name}.${d.name}`))),
		toolsExecuted: uniq(events.filter((e) => e.kind === "tool_exec").map((e) => `${e.server}.${e.name}`)),
		modelTools: uniq(events.filter((e) => e.kind === "model_tool_call").map((e) => e.name ?? "?")),
		skills: uniq(o.turns.flatMap(skillLoads)),
		guards: events.filter((e) => e.kind === "guard").map(guardReason),
		trajectories: o.turns.map((t) => t.of("model_tool_call").map((e) => e.name ?? "?")),
	};
}

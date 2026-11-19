import { expect } from "vitest";
import { agentMatchers } from "./matchers/agents.ts";
import { answerMatchers, type StandardSchemaV1 } from "./matchers/answer.ts";
import { budgetMatchers, type BudgetLimits } from "./matchers/budget.ts";
import { callMatchers } from "./matchers/calls.ts";
import { contextMatchers } from "./matchers/context.ts";
import { envelopeMatchers, type EnvelopeLimits } from "./matchers/envelopes.ts";
import { guardMatchers } from "./matchers/guards.ts";
import { redTeamMatchers } from "./matchers/redteam.ts";
import { skillMatchers } from "./matchers/skills.ts";
import { surfaceMatchers } from "./matchers/surface.ts";
import type { CalledOptions } from "./matchers/shared.ts";
import type { IssueKind } from "./surface.ts";
import { trajectoryMatchers, type TrajectoryOptions, type TrajectoryStep } from "./matchers/trajectory.ts";
import { workspaceMatchers, type WorkspaceExpectation } from "./matchers/workspace.ts";
import type { CacheBreakOptions } from "./context.ts";
import type { Attack } from "./redteam/types.ts";
import type { NamePattern } from "./trace.ts";

export type { CalledOptions } from "./matchers/shared.ts";
export type { BudgetLimits } from "./matchers/budget.ts";
export type { TrajectoryOptions, TrajectoryStep } from "./matchers/trajectory.ts";
export type { EnvelopeLimits } from "./matchers/envelopes.ts";
export type { WorkspaceExpectation } from "./matchers/workspace.ts";

export interface TestkitMatchers<R = unknown> {
	/** `name`: an exact tool name, a `*` glob (`mcp__github__delete_*`) or a RegExp. */
	toHaveCalledTool(name: NamePattern, opts?: CalledOptions): R;
	toHaveCalledMcp(server: string, tool: NamePattern, opts?: CalledOptions): R;
	toHaveLoadedSkill(name: string): R;
	/** `raw` (default true) compares text without date/id masking; `raw: false` masks them. */
	toKeepStablePrefix(opts?: { allowAfterCompaction?: boolean; raw?: boolean }): R;
	toHaveNoDuplicateBlocks(opts?: { minChars?: number }): R;
	toGrowAtMost(bytesPerTurn: number): R;
	toHaveCacheReadRatio(opts: { min: number }): R;
	/** No cold cache read after an agent's first request (provider-reported or simulated usage). */
	toKeepCacheWarm(opts?: CacheBreakOptions): R;
	toNotRetryIdentically(tool: string): R;
	toReflect(opts: { after: "error" }): R;
	toHaveSpawned(role: string, opts?: { times?: number }): R;
	toHaveNoOrphanAgents(): R;
	toHaveHandedOff(from: string, to: string): R;
	toHaveRecalledBefore(key: string, tool: string): R;
	toHaveCompacted(opts?: { times?: number }): R;
	/** The model's tool calls match `steps` (strict, ordered, unordered, superset, subset). */
	toFollowTrajectory(steps: TrajectoryStep[], opts?: TrajectoryOptions): R;
	/** Requests and token usage stay within the limits. */
	toStayWithin(limits: BudgetLimits): R;
	/** The final answer (or the string received) holds JSON that validates against a Standard Schema. */
	toMatchSchema(schema: StandardSchemaV1, opts?: { agent?: string }): R;
	/** Tool results, tool arguments and answers stay within character limits. */
	toKeepEnvelopesUnder(limits: EnvelopeLimits): R;
	/** A `SurfaceReport` (`analyzeSurface`) has no issues outside `allow`. */
	toPassSurfaceReview(opts?: { allow?: IssueKind[] }): R;
	/** A guard blocked a call the pattern names (any call without one). */
	toHaveBlocked(pattern?: NamePattern): R;
	/** The agent did not act on a red-team `Attack`: no forbidden call, no canary secret in arguments or the answer. */
	toResist(attack: Attack): R;
	/**
	 * A workspace directory, a `ProcessRun` (its `workspace`) or a `WorkspaceSnapshot` holds each path's exact text or a
	 * text matching the RegExp; `null` means the path must not exist.
	 */
	toHaveWorkspace(expected: WorkspaceExpectation): R;
	/** Every path a `WorkspaceDiff` (`diffWorkspace`) added, removed or changed matches one of the globs. */
	toChangeOnly(globs: string[]): R;
	/** A `VerifierResult` (`runVerifier`) passed: exit code 0, or a reward of at least 1. */
	toPassVerifier(): R;
}

declare module "vitest" {
	// T is unused here but must stay: vitest declares Matchers<R, T>.
	interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends TestkitMatchers<R> {}
}

export const matchers = {
	...callMatchers,
	...skillMatchers,
	...contextMatchers,
	...agentMatchers,
	...trajectoryMatchers,
	...budgetMatchers,
	...answerMatchers,
	...envelopeMatchers,
	...surfaceMatchers,
	...guardMatchers,
	...redTeamMatchers,
	...workspaceMatchers,
};

expect.extend(matchers);

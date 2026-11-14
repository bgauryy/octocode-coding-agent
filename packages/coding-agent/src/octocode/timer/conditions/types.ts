import type { TimerResult } from "../../../../../db/src/api.ts";
import type { ExtensionContext } from "../../../core/features/index.ts";

/** Characters of a check's output kept on the row and shown on wake. */
export const OUTPUT_CAP = 2000;

/** A condition code decides: the closed list. A new kind is one `ConditionSpec` in `conditions/` and one entry in `index.ts`. */
export type BaseCondition =
	| { kind: "command"; command: string }
	| { kind: "unlocked"; path: string }
	| { kind: "item"; ref: string; state: string }
	| { kind: "agent"; name: string };

/** A fuzzy condition: `on` is the deterministic trigger, and the small model judges `question` only after `on` fires. */
export type CheckCondition = { kind: "check"; question: string; on: BaseCondition };

export type TimerCondition = BaseCondition | CheckCondition;

/** A check of a condition: met, not yet, or not possible (refused or unrunnable: the timer fails). */
export type CheckOutcome = TimerResult & { met: boolean; refused?: string };

/** What a condition may read from the host. */
export interface ConditionDeps {
	/** Why `absolute` may not be changed now (another agent's reservation), or undefined: the team's own check. */
	reservation(absolute: string, display: string): string | undefined;
	/** The session the check runs for: its plan mode and project trust apply. */
	context(): ExtensionContext | undefined;
	/** The state of backlog item `ref` in the session's workspace (`closed` for an item closed without completion), or undefined. */
	item(ref: string): string | undefined;
	/** The `dependsOn` items of backlog item `ref` that are missing or not done (closed counts as done). */
	blockers(ref: string): string[] | undefined;
	/** Why the agent `name` ended (`completed`, `failed`…), or undefined while it has not. */
	agentEnd(name: string): { reason: string; detail?: string } | undefined;
	/** Calls `poke` whenever the shared database file changes (any process wrote); returns the unsubscribe. */
	watchDatabase(poke: () => void): () => void;
	/** One model judgment of a `check`, gated and capped by the host (`judge.ts`). */
	judge(request: JudgeRequest): Promise<JudgeOutcome>;
}

/** One check's surroundings: where it runs, and the host. */
export interface RunEnv {
	cwd: string;
	signal?: AbortSignal;
	deps: ConditionDeps;
	/** The timer row, for a `check`'s budget. */
	row?: { id: number; checks: number; spentUsd: number; sessionId: string };
}

/** How a kind parses, stores, checks and (when it has an event source) watches its condition. */
export interface ConditionSpec<C extends TimerCondition> {
	kind: C["kind"];
	/** The tool's argument for this kind; throws a message the model can act on. */
	parse(value: unknown): C;
	/** The text stored in `timers.condition`. */
	encode(condition: C): string;
	decode(text: string): C | undefined;
	/** A few words for the notice and `list`: `B4 is done`. */
	describe(condition: C): string;
	/** Poll interval in ms when an event source is live (the safety net), and when none is. */
	safetyMs: number;
	pollMs: number;
	check(condition: C, env: RunEnv): Promise<CheckOutcome>;
	/** An event source: calls `poke` to say "check now" (the check stays the one source of truth); returns the unsubscribe. */
	watch?(condition: C, env: RunEnv, poke: () => void, failed: () => void): () => void;
}

export const capped = (text: string) => (text.length > OUTPUT_CAP ? `…${text.slice(-OUTPUT_CAP)}` : text);

/** The `value` of an until field: an object, with only the named keys. */
export function fields(value: unknown, kind: string, allowed: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`until.${kind} must be an object with ${allowed.join(", ")}.`);
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length)
		throw new Error(`until.${kind} has no field ${unknown.join(", ")}; it takes ${allowed.join(", ")}.`);
	return value as Record<string, unknown>;
}

export function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
	return value.trim();
}

export interface JudgeRequest {
	signal?: AbortSignal;
	id: number;
	sessionId: string;
	question: string;
	/** The deterministic condition that fired, in words. */
	trigger: string;
	/** What the code observed, as quoted data. */
	evidence: string;
	checks: number;
	spentUsd: number;
}

/** What one judgment came to. `skipped`: no call was made (same evidence, too soon); `stop`: the wait must end with `reason`. */
export type JudgeOutcome =
	| { verdict: "met" | "not_met" | "unsure"; reason: string; model: string; spend: { calls: number; usd: number } }
	| { verdict: "skipped"; reason: string }
	| { verdict: "stop"; reason: string; spend?: { calls: number; usd: number } };

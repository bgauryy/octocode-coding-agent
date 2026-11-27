import type { FeatureContext } from "../../core/features/index.ts";
import { ADJECTIVES, CREATURES } from "./names.ts";
import { processStartTime } from "../shared/process.ts";
import { sanitizeTerminalText, storedText } from "@octocodeai/octocode-common/sanitize";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { AGENT_GOAL_ENV, AGENT_ROLE_ENV, PARENT_ID_ENV } from "./store/env.ts";

/** Who an agent is on the team: its name (the id), its goal, and the row it joins with. */

/**
 * Every agent's name comes from `adjective-creature` (`inky-kraken`, words in `names.ts`). The name is the team id: the
 * `sendMessage` address, the worktree ref (`refs/octocode/<name>`) and the scratch folder, so it holds only lowercase
 * letters, hyphens and digits.
 */
export { ADJECTIVES, CREATURES };

/** Longest base name (`adjective-creature`) in the main pool; a numeric suffix added as a last resort comes on top. */
export const MAX_NAME_CHARS = 16;

/** Every combination that fits in `MAX_NAME_CHARS`. */
export const AGENT_NAMES: readonly string[] = ADJECTIVES.flatMap((adjective) =>
	CREATURES.map((creature) => `${adjective}-${creature}`),
).filter((name) => name.length <= MAX_NAME_CHARS);

/** Combinations too long for the main pool: used only once every `AGENT_NAMES` entry is taken. */
const LONG_NAMES: readonly string[] = ADJECTIVES.flatMap((adjective) =>
	CREATURES.map((creature) => `${adjective}-${creature}`),
).filter((name) => name.length > MAX_NAME_CHARS);

/**
 * A name nobody in `taken` holds, chosen with `random` (0 ≤ r < 1). Names that fit `MAX_NAME_CHARS` come first, then the
 * longer combinations (a different first or last word); only when every combination is taken does a random one get the
 * smallest free numeric suffix (`inky-kraken-2`).
 */
export function agentName(taken: Iterable<string> = [], random: () => number = Math.random): string {
	const used = new Set(taken);
	for (const pool of [AGENT_NAMES, LONG_NAMES]) {
		const free = pool.filter((name) => !used.has(name));
		if (free.length > 0) return free[Math.floor(random() * free.length)];
	}
	const base = AGENT_NAMES[Math.floor(random() * AGENT_NAMES.length)];
	let suffix = 2;
	while (used.has(`${base}-${suffix}`)) suffix += 1;
	return `${base}-${suffix}`;
}

/**
 * An agent's goal: what it works on, read at a glance in the panel, `coordinate list` and message headers. It is a label,
 * not content: any length is accepted. `GOAL_SHOWN_CHARS` is the length a goal should aim for, so it reads whole in a
 * narrow panel; a wider terminal shows more of a longer one.
 */
const GOAL_SHOWN_CHARS = 48;
const GOAL_EXAMPLE = "audit auth token refresh";
export const GOAL_DESCRIPTION = `Panel verb phrase; ~${GOAL_SHOWN_CHARS} characters fit`;

/** The goal as it is stored and shown: terminal escapes removed and whitespace collapsed. Only a missing goal is refused. */
export function checkGoal(input: unknown): string {
	const goal = typeof input === "string" ? sanitizeTerminalText(input).split(/\s+/).filter(Boolean).join(" ") : "";
	if (goal === "")
		throw new Error(
			`A goal is required: pass \`goal\` (a few words on what this agent works on, for example "${GOAL_EXAMPLE}"), or an \`item\` whose title becomes the goal.`,
		);
	return goal;
}

/** Longest one-line goal or activity stored for an agent (the panel and `coordinate list` clip further). */
export const LINE_MAX = 200;

/**
 * A model as the team shows it: `provider/id:level` for a model that can think (`:off` when its thinking is off, so the
 * row says what it runs at), `provider/id` for one that cannot (no level to show). Without a provider only the id.
 */
export function modelRoute(
	model: { provider?: string | undefined; id: string; reasoning?: boolean | undefined } | undefined,
	level: string | undefined,
): string | undefined {
	if (!model?.id) return undefined;
	const name = model.provider ? `${model.provider}/${model.id}` : model.id;
	return model.reasoning === false || !level ? name : `${name}:${level}`;
}

/**
 * The row `parent`'s process holds for a child it reserved paths for, until the child's own process takes it over
 * (`claimMember`). It names the parent's process: while that runs the reservations are not an abandoned owner's, and
 * when it ends they go with it.
 */
export function heldChildMember(
	parent: Member,
	child: { id: string; role: string; goal: string },
	now: number,
): Member {
	const goal = storedText(child.goal, LINE_MAX);
	return {
		id: child.id,
		role: child.role,
		parentId: parent.id,
		pid: parent.pid,
		...(parent.started ? { started: parent.started } : {}),
		status: "working",
		...(goal ? { goal } : {}),
		joinedAt: now,
		updatedAt: now,
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		cost: 0,
		unpriced: false,
	};
}

/**
 * The row a process joins the team with. A subagent's parent chose its name, role and goal and passed them in the
 * environment; a main session is `main`, named by the caller, with the goal it gives when it joins (if any).
 */
export function newMember(
	env: NodeJS.ProcessEnv,
	ctx: FeatureContext,
	id: string,
	goal: string | undefined,
	now: number,
): Member {
	const parentId = env[PARENT_ID_ENV];
	const stored = storedText(goal ?? env[AGENT_GOAL_ENV], LINE_MAX);
	const started = processStartTime(process.pid);
	// The pane a person can switch to; a subagent inherits its parent's variables but has no pane of its own.
	const tmuxPane = !parentId && env.TMUX && /^%\d+$/u.test(env.TMUX_PANE ?? "") ? env.TMUX_PANE : undefined;
	return {
		id,
		role: env[AGENT_ROLE_ENV] ?? "main",
		...(parentId ? { parentId } : {}),
		pid: process.pid,
		...(started ? { started } : {}),
		status: ctx.isIdle() ? "idle" : "working",
		...(stored ? { goal: stored } : {}),
		...(ctx.model ? { model: storedText(ctx.model.id, LINE_MAX) } : {}),
		...(tmuxPane ? { tmuxPane } : {}),
		sessionId: ctx.sessionManager.getSessionId(),
		joinedAt: now,
		updatedAt: now,
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		cost: 0,
		unpriced: false,
	};
}

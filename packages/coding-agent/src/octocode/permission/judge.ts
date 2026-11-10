import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../../core/features/index.ts";

/**
 * The order in which a tool call is judged: two ordered, named step tables. The first step that decides wins; a step
 * that does not decide lets the next one run. Nothing else sets the order: `tool-gates.ts` and `gate.ts` only supply each
 * step's body, by name, and the compiler refuses a table entry without one.
 */

/** A gate's result: a block, or an `ask` a later gate turns into a question (PreToolUse `permissionDecision: "ask"`). */
export type GateVerdict = ToolCallEventResult & { ask?: string; rewritten?: true };

export type Gate = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
	prior?: GateVerdict,
) => Promise<GateVerdict | undefined>;

/** How a call reaches the gate: the model's own `tool_call`, or an `mcp_tool` hook's call (`hooks/mcp-gate.ts`). */
export type JudgeEntry = "tool" | "hook";

/**
 * Table 1, the `tool_call` pipeline, cheapest and most certain first. The order:
 *
 *  1. plan-mode      planning blocks what changes anything (audited here)
 *  2. git-state      a subagent in the shared tree leaves git state alone (audited); the main session is asked before it
 *                    discards uncommitted work while a peer session shares the checkout
 *  3. reservation    another agent's reserved paths (audited)
 *  4. metadata       a browser call that opens a cloud metadata address, in every mode and on every entry (audited)
 *  5. pre-tool-use   the user's PreToolUse hooks, which spawn processes, so only calls 1-4 let through; a hook's `ask`
 *                    is handed on as `prior`, and a command it rewrote runs the `invariants` again (audited)
 *  6. plan-recheck   planning again, on the call a hook may have changed (not audited: the next step audits its own)
 *  7. permission     the permission gate (table 2); it audits its own refusals and asks last, so the user is never
 *                    asked about a call a hook would deny
 *
 * `audited` steps record their refusal in `Permission.refused`. The hook entry runs only the steps flagged `hook`.
 */
export const GATE_STEPS = [
	{ name: "plan-mode", entries: ["tool"], audited: true },
	{ name: "git-state", entries: ["tool"], audited: true },
	{ name: "reservation", entries: ["tool"], audited: true },
	{ name: "metadata", entries: ["tool", "hook"], audited: true },
	{ name: "pre-tool-use", entries: ["tool"], audited: true },
	{ name: "plan-recheck", entries: ["tool", "hook"], audited: false },
	{ name: "permission", entries: ["tool", "hook"], audited: false },
] as const satisfies readonly { name: string; entries: readonly JudgeEntry[]; audited: boolean }[];

export type GateStepName = (typeof GATE_STEPS)[number]["name"];

/** A step's body; `git-state` is undefined for an isolated subagent and for a main session that cannot tell about peers, which skip the step. */
export type GateStepBodies = { [N in GateStepName]: N extends "git-state" ? Gate | undefined : Gate };

interface JudgeOptions {
	/** Records a refusal by a step flagged `audited`. */
	audited: (gate: Gate) => Gate;
	/** The invariants (steps 1-4), run again for a command a hook rewrote. */
	invariants: Gate;
}

/** Runs table 1 for `entry`: the first block wins; a PreToolUse `ask` reaches the later steps as `prior`. */
export async function judge(
	entry: JudgeEntry,
	bodies: GateStepBodies,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	options: JudgeOptions,
): Promise<GateVerdict | undefined> {
	let prior: GateVerdict | undefined;
	for (const step of GATE_STEPS) {
		if (!(step.entries as readonly JudgeEntry[]).includes(entry)) continue;
		const body = bodies[step.name];
		if (!body) continue;
		const verdict = await (step.audited ? options.audited(body) : body)(event, ctx, prior);
		if (verdict?.block || verdict?.defer) return verdict;
		if (verdict?.rewritten) {
			const reserved = await options.audited(options.invariants)(event, ctx);
			if (reserved?.block) return reserved;
		}
		if (verdict?.ask) prior = { ask: verdict.ask };
	}
	return undefined;
}

/**
 * Table 2, inside the permission step: what the permission gate decides, in order. A step either decides (a block, or an
 * allow that skips the dialog) or only fills in what a later step reads. The current order, kept as it was:
 *
 *  1. source-projection  a call whose input cannot be projected for source policy and is `unsupported` there: block
 *  2. role               a read-only role or an isolated child may not change what it was refused: block, in every mode
 *  3. classify           the call's effect class (a browser/upload request, else `classify`; PowerShell parsed first)
 *  4. landing            a `bash` git call that reaches the protected branch becomes `worktree.merge`
 *  5. provenance         the tripwire for text an untrusted source supplied
 *  6. reasons            provenance and a hook's `ask` tighten the call's effect into one request
 *  7. no-effect          no request and no source policy: allow, nothing to ask
 *  8. source-policy-file a `file` call with no request is judged by source policy alone: deny/unsupported block, else allow
 *  9. check              `Permission.check`: the mode, the record and the user's answer
 *
 * Steps 1-2 refuse before any dialog. Steps 3-6 only build the request; 7, 8 and 9 decide, and 9 always does.
 */
export const PERMISSION_STEPS = [
	"source-projection",
	"role",
	"classify",
	"landing",
	"provenance",
	"reasons",
	"no-effect",
	"source-policy-file",
	"check",
] as const;

type PermissionStepName = (typeof PERMISSION_STEPS)[number];

/** A step's decision: the gate's result, which may be `undefined` (allow). A step that does not decide returns nothing. */
export interface Decision {
	result: ToolCallEventResult | undefined;
}

export type PermissionStepBodies<S> = Record<
	PermissionStepName,
	(state: S) => Promise<Decision | void> | Decision | void
>;

/** Runs table 2: the first step that decides wins. */
export async function decide<S>(bodies: PermissionStepBodies<S>, state: S): Promise<ToolCallEventResult | undefined> {
	for (const name of PERMISSION_STEPS) {
		const decision = await bodies[name](state);
		if (decision) return decision.result;
	}
	throw new Error("No permission step decided the call");
}

import type { ProviderPlan } from "@octocodeai/octocode-ai";
import type { ExternalUsage } from "@octocodeai/octocode-contracts/external";
import type { ExtensionContext } from "../../core/features/index.ts";

/** Who pays for a runner's turns: its own plan (a subscription it signed in with) or a metered key. */
export type RunnerBilling = ProviderPlan["billing"];

/** One task's turn in a vendor CLI over ACP, as `octocode/index.ts` supplies it from `external/` (subagents import no transport). */
interface RunnerTurn {
	runner: string;
	/** A value of the runner's own model option (`opus`), checked by the runner. */
	model?: string;
	cwd: string;
	/** The whole message the runner receives: the task and its report contract. */
	text: string;
	signal: AbortSignal;
	/** A short line per tool call or plan the runner streams, for the child's row. */
	onActivity(line: string): void;
	/** The runner's process, once it runs: an isolated child's worktree records it like a native child's. */
	onStart?(pid: number): void;
	/** Where the runner's permission requests go: the session's dialog, or its full-mode policy. */
	ctx: ExtensionContext;
}

/** What a runner's turn ended with: its answer, stop reason, and the token totals and cost it reported. */
export interface RunnerReply {
	text: string;
	stopReason?: string;
	usage?: ExternalUsage;
	/** The cost the runner reported, in dollars; a plan-billed run counts none of it. */
	cost?: number;
	billing: RunnerBilling;
}

/** The connected runners of this session, fixed when the `agent` tool is declared, and how a turn runs in one. */
export interface Runners {
	readonly ids: readonly string[];
	turn(input: RunnerTurn): Promise<RunnerReply>;
}

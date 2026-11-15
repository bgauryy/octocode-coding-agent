import type { ProviderPlan } from "@octocodeai/octocode-ai";
import type { ExternalUsage } from "@octocodeai/octocode-contracts/external";
import type { ExtensionContext } from "../../core/features/index.ts";

/** Who pays for a runner's turns: its own plan (a subscription it signed in with) or a metered key. */
export type RunnerBilling = ProviderPlan["billing"];

/** One turn's only admitted MCP server; the host owns its identity, bearer token and lifetime. */
interface RunnerCommunication {
	name: string;
	url: string;
	headers: readonly { name: string; value: string }[];
}

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
	communication?: RunnerCommunication;
}

/** What a runner's turn ended with: its answer, stop reason, and the token totals and cost it reported. */
export interface RunnerReply {
	text: string;
	stopReason?: string;
	usage?: ExternalUsage;
	/** The cost the runner reported, in dollars; a plan-billed run counts none of it. */
	cost?: number;
	/** Absent when the runner's sign-in probe did not establish who pays. */
	billing?: RunnerBilling;
}

/** The installed runners available in this session, fixed at tool declaration; a turn checks sign-in before launch. */
export interface Runners {
	readonly ids: readonly string[];
	/** Installed routes proven to accept the restricted team server without ambient MCP or skills. */
	readonly communication?: readonly string[];
	turn(input: RunnerTurn): Promise<RunnerReply>;
}

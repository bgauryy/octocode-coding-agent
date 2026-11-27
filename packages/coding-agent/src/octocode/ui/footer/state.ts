import type { Activity } from "@octocodeai/octocode-projections";
import type { ProviderKind } from "../../../core/model-runtime/catalog.ts";
import type { ChipParts } from "../../permission/mode.ts";
import type { LiveAgent } from "../../shared/team-spend.ts";
import type { TokenTotals } from "../../shared/util.ts";

/** What the footer draws besides the statuses and the git branch, sampled on events (`ui/footer.ts`). */
export interface FooterState {
	/** Whether Octocode's GitHub tools have a token (`footer/github.ts`); undefined hides the mark. */
	githubToken?: boolean | undefined;
	model?: string | undefined;
	/** What the model's provider is (subscription, API key, account, CLI, local): shown beside the model. */
	kind?: ProviderKind | undefined;
	/** Thinking level, only for models that reason: drawn as `model:effort`. */
	thinking?: string | undefined;
	/**
	 * `window` is the model's context window (what `/context` measures against); `percent` is of `window`, and null
	 * right after compaction, until the next response. `compactAt` is where Octocode compacts automatically: it only
	 * moves the alarm colour, never the figure.
	 */
	context?: { percent: number | null; window: number; compactAt?: number } | undefined;
	/** The session ledger: its replies, recorded spend and every subagent result or report added so far. `input` is the whole prompt (cache reads included); `cost` is Octocode's estimate. */
	usage: TokenTotals;
	/**
	 * The spend in `usage` a plan paid for (`entryBilling`: replies, recorded requests, summaries and subagent runs), how
	 * many such entries and their estimated cost: `Σ` shows it apart from money.
	 */
	planBilled?: { replies: number; cost: number } | undefined;
	/** Subagents whose result or report `usage` already holds: `Σ` does not add their live rows again. */
	reported?: ReadonlySet<string>;
	/** This session's live descendants (`team/panel.ts`): `Σ` adds what they spent until they report. */
	live?: readonly LiveAgent[];
	/**
	 * The model's provider's plan window closest to its cap, at 70 % or more (`tightestPlanWindow`): `label` (`5h`,
	 * `week`), the share used and when it resets. Undefined below 70 %: the footer shows no quota then.
	 */
	quota?: { label: string; usedFraction: number; resetsAt?: number | undefined } | undefined;
	/** A run is in progress. The run's time is the transcript's turn line (`Worked 12s`), not the footer's. */
	running?: boolean;
	/** The session's activity light (`followSessionActivity`): working, waiting for the user, failed, or idle. */
	activity?: Activity | undefined;
	/** Completed compaction entries across the session, including resumed history. */
	compactions?: number;
	cwd: string;
	home?: string | undefined;
	sessionName?: string | undefined;
	/** The permission chip; none until the mode is known. */
	chip?: ChipParts | undefined;
}

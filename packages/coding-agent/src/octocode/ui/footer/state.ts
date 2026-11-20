import type { ProviderKind } from "../../../core/model-runtime/catalog.ts";
import type { ChipParts } from "../../permission/mode.ts";
import type { LiveAgent } from "../../shared/team-spend.ts";
import type { UsageTotals } from "../../shared/util.ts";

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
	usage: UsageTotals;
	/** This session's own replies whose provider bills by plan, and their estimated cost: all of the ledger means `Σ (sub)`. */
	planBilled?: { replies: number; cost: number } | undefined;
	/** Subagents whose result or report `usage` already holds: `Σ` does not add their live rows again. */
	reported?: ReadonlySet<string>;
	/** This session's live descendants (`team/panel.ts`): `Σ` adds what they spent until they report. */
	live?: readonly LiveAgent[];
	/** A run is in progress. The run's time is the transcript's turn line (`Worked 12s`), not the footer's. */
	running?: boolean;
	/** Completed compaction entries across the session, including resumed history. */
	compactions?: number;
	cwd: string;
	home?: string | undefined;
	sessionName?: string | undefined;
	/** The permission chip; none until the mode is known. */
	chip?: ChipParts | undefined;
}

import { BYTES_PER_TOKEN, RESULT_DEFAULT_LINES } from "../../../utils/output-budget.ts";
import { SETTINGS_DEFAULTS } from "../../settings-defaults.ts";

/** What one foreground bash result may put into the model's context: the shared default (20 KB, 500 lines; see `output-budget.ts`). */
export const BASH_MAX_BYTES = SETTINGS_DEFAULTS.bashOutputMaxBytes;
export const BASH_MAX_LINES = RESULT_DEFAULT_LINES;

/** The smallest `maxOutputTokens` a call can ask for. */
const MIN_OUTPUT_TOKENS = 100;
const MIN_LINES = 20;

export interface BashBudget {
	maxBytes: number;
	maxLines: number;
}

/**
 * The limits of one call. `maxBytes` is the `bashOutputMaxBytes` setting; the line limit scales with it (500 lines
 * per 20 KB). `maxOutputTokens` can only lower the budget for the call, at about 4 bytes per token and down to
 * `MIN_OUTPUT_TOKENS`: the user's setting is the ceiling, so a call cannot grow its own result in the context. The full
 * output is saved either way and the result header names its file. A value that is not a number is ignored.
 */
export function bashBudget(maxBytes = BASH_MAX_BYTES, maxOutputTokens?: number): BashBudget {
	let bytes = maxBytes;
	if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
		const tokens = Math.max(Math.floor(maxOutputTokens), MIN_OUTPUT_TOKENS);
		bytes = Math.min(maxBytes, tokens * BYTES_PER_TOKEN);
	}
	return { maxBytes: bytes, maxLines: Math.max(MIN_LINES, Math.round((BASH_MAX_LINES * bytes) / BASH_MAX_BYTES)) };
}

/**
 * The one policy for how much tool output reaches the model. Tools stay within these numbers and trim through
 * `octocode/shared/spill.ts` (`capResultText`, `spillOutput`); bash trims while it streams (`core/tools/bash/budget.ts`)
 * to its own, lower default. The numbers are bytes for byte-budgeted tools (bash, MCP text) and characters for page tools
 * (web); they agree for ASCII text.
 *
 * Evidence for the values (88 recorded sessions): the 99th percentile of 3,600 bash results is 11.5 KB and of 885
 * Octocode localFetch results 21 KB, and no assistant message carried more than 61,000 characters of tool text.
 */

/** UTF-8 bytes per model token, roughly. */
export const BYTES_PER_TOKEN = 4;

/** What one tool result keeps whole when the call asks for no size: 5,000 tokens. */
export const RESULT_DEFAULT_BYTES = 5_000 * BYTES_PER_TOKEN;
/**
 * What one foreground bash result keeps whole by default: 3,000 tokens. Lower than the shared default because bash is
 * most of all result tokens and its output (test runs, diffs) is cheap to read again from the saved file by range.
 */
export const BASH_RESULT_DEFAULT_BYTES = 3_000 * BYTES_PER_TOKEN;
/** What one `web` page fetch returns when the call sets no `maxChars`: 2,000 tokens; the rest is in the saved file. */
export const WEB_FETCH_DEFAULT_CHARS = 2_000 * BYTES_PER_TOKEN;
/** Lines of a default-sized result, for tools that also bound lines (bash). */
export const RESULT_DEFAULT_LINES = 500;

/**
 * The most a call can ask for in one result (the Octocode `responseChars` maximum, `web` `maxChars`). A size up to this is
 * a deliberate request; the default above applies to everything else.
 */
export const REQUEST_MAX_CHARS = 50_000;
/** The most one text part keeps whole: a requested page plus headroom for the notes around it. A longer part is saved and previewed. */
export const TEXT_MAX_CHARS = REQUEST_MAX_CHARS + 10_000;
/**
 * Characters of tool results one assistant message may put in the context whole: two requested pages. A message that needs
 * more finds the rest in the file its last result names.
 */
export const TURN_MAX_CHARS = 2 * REQUEST_MAX_CHARS;

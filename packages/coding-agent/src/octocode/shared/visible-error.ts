import { visibleControls } from "../../../../common/src/sanitize.ts";

/**
 * An error whose message shows control and invisible characters as visible escapes (`visibleControls`). Errors of the
 * `web` tool carry page text to the model (a page's option labels, a script's exception, a URL or a host
 * name), so they are escaped where they leave the tool. The error itself, and so its type, is kept.
 */
export function visibleError<T>(error: T): T {
	if (error instanceof Error) error.message = visibleControls(error.message);
	return error;
}

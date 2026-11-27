import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities } from "../terminal-image/capabilities.ts";
import { hyperlink } from "../terminal-image.ts";

/**
 * `text` as an OSC 8 link to the file at `path` (resolved against `cwd`) where the terminal supports hyperlinks, the
 * unchanged text elsewhere. The URL names this host, `file://<hostname>/abs/path`, so a terminal on another machine (ssh)
 * does not open its own file of that name. A line number stays in the label: `file://` has no portable form for one.
 */
export function linkPath(
	text: string,
	path: string,
	cwd: string = process.cwd(),
	enabled: boolean = getCapabilities().hyperlinks,
): string {
	if (!enabled || path === "") return text;
	const url = pathToFileURL(resolve(cwd, path));
	url.hostname = hostname();
	return hyperlink(text, url.href);
}

import os from "node:os";

/** `cd <dir> &&` (or `;`) at the start of a command, after an optional `shell:` label. */
const LEADING_CD = /^((?:[\w.-]+:\s*)?)cd\s+(?:"[^"]*"|'[^']*'|[^\s&;]+)\s*(?:&&|;)\s*/;

/**
 * What an agent does now, as a row shows it: the command itself, not the `cd <path> &&` that points it at a folder, and
 * paths inside the agent's checkout relative to it and under the home folder as `~`.
 */
export function activityText(
	activity: string | undefined,
	roots: ReadonlyArray<string | undefined>,
	home: string = os.homedir(),
): string {
	if (!activity) return "";
	let text = activity.replace(LEADING_CD, "$1");
	const folders = roots
		.filter((root): root is string => root !== undefined && root.length > 1)
		.map((root) => root.replace(/\/+$/, ""))
		.sort((a, b) => b.length - a.length);
	for (const root of folders) text = text.split(`${root}/`).join("");
	if (home.length > 1) text = text.split(`${home.replace(/\/+$/, "")}/`).join("~/");
	return text;
}

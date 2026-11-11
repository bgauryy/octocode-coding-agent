import { browserMcpParts, browserMcpTool } from "../../../../common/src/browser-mcp.ts";

// The browser MCP call classification behind the `browser.control`, `browser.cookies` and upload asks. Common keeps
// what a call hands the browser (`browserMcpParts`, `browserMcpUrls`), which the MCP proxy shares; deciding which of
// those parts need a person's answer is permission policy, so it lives here.

/** CDP methods that read or change the browser's cookies, as the package's `cookies` tool does. */
const COOKIE_CDP = new Set([
	"Network.getCookies",
	"Network.getAllCookies",
	"Network.setCookie",
	"Network.setCookies",
	"Network.deleteCookies",
	"Network.clearBrowserCookies",
	"Storage.getCookies",
	"Storage.setCookies",
	"Storage.clearCookies",
]);
/** CDP methods that let Chrome save downloads, to the folder the caller names or to the default one. */
const DOWNLOAD_CDP = new Set(["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]);
/** A CDP method that carries another command as a string, so it may be any of the above. */
const WRAPPING_CDP = new Set(["Target.sendMessageToTarget"]);

/** One thing a browser MCP call does beyond driving pages in the isolated browser. */
interface BrowserMcpEscalation {
	/** `control`: it takes control of the browser or the machine (a `browser.control` ask); `cookies`: it reads or changes cookies (a `browser.cookies` ask); `upload`: it sends `path` to a page. */
	kind: "control" | "cookies" | "upload";
	/** What it does, as a noun phrase ("Using your real browser profile (--profile Default)"). */
	what: string;
	/** For an upload, the local file as given (relative to the server's folder, the session's). */
	path?: string;
}

/** The value after each launcher flag matching `pattern`, given as `--flag value` or `--flag=value`. */
function flagValues(args: readonly string[], pattern: RegExp): Array<string | undefined> {
	const values: Array<string | undefined> = [];
	for (let index = 0; index < args.length; index++) {
		const match = pattern.exec(args[index]);
		if (match) values.push(match[1] ?? (args[index + 1]?.startsWith("--") ? undefined : args[index + 1]));
	}
	return values;
}

/** Upload paths in an `act` value: one path, `a|b` (the package's separator) or a list. */
const uploadPaths = (value: unknown): string[] =>
	(Array.isArray(value) ? value : typeof value === "string" ? value.split("|") : [])
		.filter((each): each is string => typeof each === "string")
		.map((each) => each.trim())
		.filter(Boolean);

/**
 * What a browser MCP call does beyond driving pages in the isolated browser, which the generic MCP class does not
 * cover: launcher arguments that leave the isolated profile (`--profile`: the user's real browser with its logins;
 * `--chromePath`: any program, run as the browser), raw CDP commands that read or change cookies or let Chrome save
 * downloads, and files sent to a page (an `upload` action or `DOM.setFileInputFiles`). Flags match case-insensitively
 * and in either spelling, so a variant the launcher would ignore is still flagged.
 */
export function browserMcpEscalations(toolName: string, input: Record<string, unknown>): BrowserMcpEscalation[] {
	if (browserMcpTool(toolName) === undefined) return [];
	const { cdp, acts, args } = browserMcpParts(input);
	const found: BrowserMcpEscalation[] = [];
	const upload = (path: string) => found.push({ kind: "upload", what: `Uploading ${path}`, path });
	for (const value of flagValues(args, /^--profile(?:=(.*))?$/i))
		found.push({ kind: "control", what: `Using your real browser profile (--profile ${value ?? "Default"})` });
	for (const value of flagValues(args, /^--chrome-?path(?:=(.*))?$/i))
		found.push({ kind: "control", what: `Starting ${value ?? "a program"} as the browser (--chromePath)` });
	for (const { method, params } of cdp) {
		if (COOKIE_CDP.has(method))
			found.push({ kind: "cookies", what: `CDP ${method}, which reads or changes the browser's cookies` });
		else if (DOWNLOAD_CDP.has(method) && params.behavior !== "deny" && params.behavior !== "default")
			found.push({
				kind: "control",
				what: `CDP ${method}, which lets Chrome save downloads to ${typeof params.downloadPath === "string" ? params.downloadPath : "its download folder"}`,
			});
		else if (WRAPPING_CDP.has(method))
			found.push({ kind: "control", what: `CDP ${method}, which sends a command the check cannot see` });
		else if (method === "DOM.setFileInputFiles") uploadPaths(params.files).forEach(upload);
	}
	for (const act of acts) if (act.action === "upload") uploadPaths(act.value).forEach(upload);
	return found;
}

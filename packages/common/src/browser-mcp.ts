import { BROWSER_SERVER, mcpNamespace } from "./mcp-names.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

const PREFIX = `${mcpNamespace(BROWSER_SERVER)}__`;

/** The browser MCP server's tool name in `name` (`mcp__browser__run` → `run`), or undefined for any other tool. */
export const browserMcpTool = (name: string): string | undefined =>
	name.startsWith(PREFIX) ? name.slice(PREFIX.length) : undefined;

/** CDP methods whose `params.url` opens a page. */
const NAVIGATING_CDP = new Set(["Page.navigate", "Target.createTarget"]);

type Cdp = { method: string; params: Record<string, unknown> };

/**
 * What a browser MCP call hands the browser, from every place the package (`@octocodeai/octocode-chrome-devtools`)
 * reads it: raw CDP commands (the `cdp` tool, plan and step `cdp` operations), page actions (plan and step `act`
 * operations, and the legacy `dom-operations-check` recipe's `DOM_ACTION`/`DOM_VALUE` or `DOM_STEPS` options) and
 * launcher arguments (`args`, which the package appends to any command).
 */
function parts(input: Record<string, unknown>): { cdp: Cdp[]; acts: Record<string, unknown>[]; args: string[] } {
	const cdp: Cdp[] = [];
	const acts: Record<string, unknown>[] = [];
	const addCdp = (method: unknown, params: unknown) => {
		if (typeof method === "string") cdp.push({ method, params: isRecord(params) ? params : {} });
	};
	const step = (value: unknown) => {
		if (!isRecord(value)) return;
		if (value.op === "cdp") addCdp(value.method, value.params);
		else if (value.op === "act") acts.push(value);
	};
	if (isRecord(input.plan) && Array.isArray(input.plan.steps)) input.plan.steps.forEach(step);
	step(input.step);
	addCdp(input.method, input.params);
	if (isRecord(input.options)) {
		const { DOM_ACTION, DOM_VALUE, DOM_STEPS, steps } = input.options;
		if (DOM_ACTION !== undefined) acts.push({ action: DOM_ACTION, value: DOM_VALUE });
		for (const listed of [DOM_STEPS, steps]) {
			let parsed = listed;
			if (typeof listed === "string")
				try {
					parsed = JSON.parse(listed);
				} catch {
					continue; // The recipe refuses steps that are not JSON.
				}
			if (Array.isArray(parsed)) for (const each of parsed) if (isRecord(each)) acts.push(each);
		}
	}
	const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [];
	return { cdp, acts, args };
}

/**
 * The addresses a browser MCP call asks Chrome to open: `open`'s `url`, a connection's `newTab`, plan and step `goto`
 * URLs, and the URL of a navigating CDP command. Pages the opened page then loads, and links a click follows, are not
 * known before the call runs.
 */
export function browserMcpUrls(toolName: string, input: Record<string, unknown>): string[] {
	if (browserMcpTool(toolName) === undefined) return [];
	const urls: string[] = [];
	const add = (value: unknown) => {
		if (typeof value === "string" && value.trim()) urls.push(value.trim());
	};
	add(input.url);
	if (isRecord(input.connection)) add(input.connection.newTab);
	const steps = [...(isRecord(input.plan) && Array.isArray(input.plan.steps) ? input.plan.steps : []), input.step];
	for (const value of steps) if (isRecord(value) && value.op === "goto") add(value.url);
	for (const { method, params } of parts(input).cdp) if (NAVIGATING_CDP.has(method)) add(params.url);
	return [...new Set(urls)];
}

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
export interface BrowserMcpEscalation {
	/** `control`: it takes control of the browser or the machine (a `browser.control` ask); `upload`: it sends `path` to a page. */
	kind: "control" | "upload";
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
	const { cdp, acts, args } = parts(input);
	const found: BrowserMcpEscalation[] = [];
	const upload = (path: string) => found.push({ kind: "upload", what: `Uploading ${path}`, path });
	for (const value of flagValues(args, /^--profile(?:=(.*))?$/i))
		found.push({ kind: "control", what: `Using your real browser profile (--profile ${value ?? "Default"})` });
	for (const value of flagValues(args, /^--chrome-?path(?:=(.*))?$/i))
		found.push({ kind: "control", what: `Starting ${value ?? "a program"} as the browser (--chromePath)` });
	for (const { method, params } of cdp) {
		if (COOKIE_CDP.has(method))
			found.push({ kind: "control", what: `CDP ${method}, which reads or changes the browser's cookies` });
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

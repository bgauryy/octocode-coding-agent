import { browserMcpParts, browserMcpTool } from "@octocodeai/octocode-common/browser-mcp";

// The browser MCP call classification behind the `browser.control`, `browser.cookies` and upload asks. Common keeps
// what a call hands the browser (`browserMcpParts`, `browserMcpUrls`), which the MCP proxy shares; deciding which of
// those parts need a person's answer is permission policy, so it lives here.

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

/** Upload paths in an `act` value: one path, `a|b` (the package's separator) or a list. */
const uploadPaths = (value: unknown): string[] =>
	(Array.isArray(value) ? value : typeof value === "string" ? value.split("|") : [])
		.filter((each): each is string => typeof each === "string")
		.map((each) => each.trim())
		.filter(Boolean);

/**
 * What a browser MCP call does beyond driving pages in the isolated browser, which the generic MCP class does not
 * cover: attaching to a browser the user already runs (its logins), another program as the browser
 * (`launch.chromePath`), page scripts (`evaluate` steps, a flow's `trigger`), raw CDP, which can execute arbitrary
 * code or reach cookies and downloads, and files sent to a page (an `upload` action or `DOM.setFileInputFiles`).
 */
export function browserMcpEscalations(toolName: string, input: Record<string, unknown>): BrowserMcpEscalation[] {
	const tool = browserMcpTool(toolName);
	if (tool === undefined) return [];
	const { cdp, acts, scripts, launch, attach } = browserMcpParts(input);
	const found: BrowserMcpEscalation[] = [];
	// Raw protocol is opaque: a method allowlist cannot prove no cookie access.
	if (tool === "cdp" || cdp.length > 0)
		found.push({
			kind: "cookies",
			what: `Raw CDP${cdp.length > 0 ? ` (${cdp.map(({ method }) => method).join(", ")})` : ""}, which can execute arbitrary browser code or access cookies`,
		});
	for (const { source } of scripts)
		found.push({ kind: "control", what: `A custom page script (${source}), which runs arbitrary code in the page` });
	if (attach)
		found.push({
			kind: "control",
			what: "Attaching to a browser you already run, with its logged-in pages and cookies",
		});
	if (typeof launch.chromePath === "string")
		found.push({
			kind: "control",
			what: `Starting ${launch.chromePath || "a program"} as the browser (launch.chromePath)`,
		});
	const upload = (path: string) => found.push({ kind: "upload", what: `Uploading ${path}`, path });
	for (const { method, params } of cdp) {
		if (DOWNLOAD_CDP.has(method) && params.behavior !== "deny" && params.behavior !== "default")
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

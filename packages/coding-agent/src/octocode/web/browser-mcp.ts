import { browserEscalations } from "../permission/browser-escalation.ts";
import type { ActionClass } from "../permission/mode.ts";
import type { PermissionRequest } from "../permission/request.ts";
import { browserMcpTool, browserMcpUrls } from "../../../../common/src/browser-mcp.ts";
import { classifyHost, type HostLookup, isHttpUrl } from "../../../../common/src/web-guard.ts";

const VERDICT_TTL_MS = 60 * 60_000;
const VERDICTS_MAX = 500;
/** What the permission check decided for each `hostname:port` it saw: true when it was a `net.private` ask. */
const verdicts = new Map<string, { asked: boolean; at: number }>();

function remember(key: string, asked: boolean): void {
	verdicts.delete(key);
	verdicts.set(key, { asked, at: Date.now() });
	for (const [old, { at }] of verdicts) {
		if (verdicts.size <= VERDICTS_MAX && Date.now() - at < VERDICT_TTL_MS) break;
		verdicts.delete(old);
	}
}

/**
 * Whether the permission check asked `net.private` for `key` (`hostname:port`, brackets off an IPv6 literal), or
 * undefined when it has not seen the host recently (no permission check ran: an SDK session). The page-request filter
 * approves a host for the pages it loads only when the check asked about it and the call then ran, so a name that
 * resolved public at the check and private later (DNS rebinding) is never approved.
 */
export function browserMcpAsked(key: string): boolean | undefined {
	const verdict = verdicts.get(key);
	return verdict && Date.now() - verdict.at < VERDICT_TTL_MS ? verdict.asked : undefined;
}

/**
 * Browser MCP tools that take control beyond opening pages, each a `browser.control` ask on every call, as the native
 * browser's script and attach are: custom code with full protocol access, cookie transfer, and replaying a request.
 */
const CONTROL: Record<string, string> = {
	script: "Run custom code against the browser?",
	cookies: "Transfer browser cookies?",
	api_replay: "Replay a captured request?",
};

/**
 * The permission a browser MCP call needs beyond the generic MCP class, or undefined when it needs none. A page the
 * agent asks Chrome to open at a private or local address, or under a name that does not resolve here (it may resolve
 * to one in Chrome), is a `net.private` ask with a per-host session grant, like `web`; a non-web URL (`file:`,
 * `chrome:`, `data:`) asks the same way without a grant. Requests the opened page makes itself are not checked here:
 * the browser server's Chrome runs behind a filtering proxy that approves only these hosts
 * (`mcp/src/presets/browser/proxy.ts`). The `CONTROL` tools, the user's real profile or another program as the
 * browser, and raw CDP on cookies or downloads are `browser.control`; files from outside the workspace (`cwd`'s)
 * sent to a page are `upload.outside` (`permission/browser-escalation.ts`). A call that is several of these asks once,
 * naming them all, with no session grant.
 */
export async function browserMcpRequest(
	toolName: string,
	input: Record<string, unknown>,
	lookup?: HostLookup,
	cwd: string = process.cwd(),
): Promise<PermissionRequest | undefined> {
	const tool = browserMcpTool(toolName);
	if (tool === undefined) return undefined;
	const escalations = browserEscalations(toolName, input, cwd);
	const control = [
		...(Object.hasOwn(CONTROL, tool) ? [`${toolName} ${JSON.stringify(input)}`] : []),
		...escalations.control,
	];
	const risky: Array<{ key?: string; what: string }> = [];
	for (const raw of browserMcpUrls(toolName, input)) {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			continue; // The server refuses an invalid URL itself.
		}
		if (url.protocol === "about:") continue;
		if (!isHttpUrl(url)) {
			risky.push({ what: `The browser wants to open ${raw}, which is not a web address.` });
			continue;
		}
		const host = await classifyHost(url, lookup);
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		remember(`${url.hostname.replace(/^\[|\]$/g, "")}:${port}`, host.kind !== "public");
		if (host.kind === "public") continue;
		risky.push({
			key: `${url.hostname}:${port}`,
			what: `The browser wants to open ${url.host}, ${
				host.kind === "private"
					? "a local or private network address"
					: "a name that does not resolve here and may reach a local or private address"
			}.`,
		});
	}
	const classes: ActionClass[] = [
		...(control.length > 0 ? ["browser.control" as const] : []),
		...(escalations.outside.length > 0 ? ["upload.outside" as const] : []),
		...(risky.length > 0 ? ["net.private" as const] : []),
	];
	const [action, ...also] = classes;
	if (action === undefined) return undefined;
	const keys = [...new Set(risky.map((entry) => entry.key))];
	return {
		action,
		...(also.length > 0 ? { also } : {}),
		title:
			action === "browser.control"
				? Object.hasOwn(CONTROL, tool)
					? CONTROL[tool]
					: "Take control of the browser?"
				: action === "upload.outside"
					? "Upload files from outside the workspace to the page?"
					: "Open a private address in the browser?",
		what: [...control, ...escalations.outside, ...risky.map((entry) => entry.what)],
		...(action === "net.private" && also.length === 0 && keys.length === 1 && keys[0]
			? { grant: { key: keys[0], label: keys[0] } }
			: {}),
	};
}

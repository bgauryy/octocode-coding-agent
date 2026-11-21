import path from "node:path";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { DESKTOP_SERVER, mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { isWithin } from "@octocodeai/octocode-common/paths";
import {
	classifyHost,
	defaultLookup,
	type HostLookup,
	isHttpUrl,
	metadataRefusal,
	reachesMetadata,
} from "@octocodeai/octocode-common/web-guard";
import { workspaceRoot } from "../../utils/git-repository.ts";
import type { ActionClass } from "./action-classes.ts";
import { deniedAppRefusal, outsideAppsRefusal, psApp } from "./desktop-apps.ts";
import { mcpCallChange } from "./mcp-reads.ts";
import type { PermissionRequest } from "./request.ts";

const PREFIX = `${mcpNamespace(DESKTOP_SERVER)}__`;

/** The Driver tool a desktop MCP call is, or undefined for any other call. */
const desktopTool = (toolName: string): string | undefined =>
	toolName.startsWith(PREFIX) ? toolName.slice(PREFIX.length) : undefined;

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** The addresses a desktop call asks a browser to open: `browser_navigate`'s `url` and the `urls` of `launch_app`. */
function desktopUrls(toolName: string, input: Record<string, unknown>): string[] {
	const tool = desktopTool(toolName);
	if (tool === "browser_navigate") return typeof input.url === "string" ? [input.url] : [];
	if (tool === "launch_app") return strings(input.urls);
	return [];
}

/** Launch arguments that open a browser's debugging port or point it at another profile: Driver's own guide says never to pass them. */
const BROWSER_PROFILE_FLAG = /^--(?:remote-debugging|user-data-dir|disable-web-security|no-sandbox)/;

/** Driver tools that ask every call, even in a child its parent approved at start (`desktop.sensitive`). */
const SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
	"clipboard_read",
	"clipboard_write",
	"kill_app",
	"replay_trajectory",
	"escalate_session",
	"start_recording",
	"browser_download",
	"browser_set_input_files",
]);

/**
 * The refusal for a desktop call no mode allows, or undefined: an app on the default denylist (a terminal, code editor,
 * password manager or Keychain, by `launch_app` name or bundle id, or by the `pid` a call targets, resolved with
 * `resolveApp`; a pid that cannot be resolved is not refused), an app outside the list the task may control
 * (`OCTOCODE_DESKTOP_APPS`, set for a desktop child whose task gave `apps`), a browser launched with debugging, profile or security
 * flags (the way to reach a personal profile around Driver's consent), and an address that reaches a cloud metadata
 * service, an invariant in every mode as for `web`.
 */
export async function desktopRefusal(
	toolName: string,
	input: Record<string, unknown>,
	lookup: HostLookup = defaultLookup,
	resolveApp: (pid: number) => Promise<string | undefined> = psApp,
): Promise<string | undefined> {
	const tool = desktopTool(toolName);
	if (tool === undefined) return undefined;
	if (tool === "launch_app")
		for (const key of ["name", "bundle_id"])
			if (typeof input[key] === "string") {
				const denied = deniedAppRefusal(input[key]) ?? outsideAppsRefusal(input[key]);
				if (denied) return denied;
			}
	if (typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 0) {
		const app = await resolveApp(input.pid);
		const denied = app === undefined ? undefined : (deniedAppRefusal(app) ?? outsideAppsRefusal(app));
		if (denied) return denied;
	}
	const flag = strings(input.additional_arguments).find((argument) => BROWSER_PROFILE_FLAG.test(argument));
	if (flag)
		return `Launching an app with ${flag.split("=")[0]} is refused: it opens a browser's debugging port or profile around the consent Cua Driver requires.`;
	for (const raw of desktopUrls(toolName, input)) {
		const url = URL.canParse(raw) ? new URL(raw) : undefined;
		if (url && isHttpUrl(url) && (await reachesMetadata(url, lookup))) return metadataRefusal(url.host);
	}
	return undefined;
}

/** The files of `paths` outside the workspace (symlinks resolved); with no workspace, every one. */
function outsideWorkspace(paths: readonly string[], cwd: string): string[] {
	const workspace = workspaceRoot(cwd);
	const root = workspace === undefined ? undefined : canonicalPath(workspace);
	return [
		...new Set(
			paths
				.map((file) => canonicalPath(path.resolve(cwd, file)))
				.filter((file) => root === undefined || !isWithin(file, root)),
		),
	];
}

/**
 * The ask for a call to the `desktop` MCP server (Cua Driver), or undefined for any other call. Every tool asks
 * `desktop.control`, in every mode but `bypass`, unless the trusted server entry declares it read-only (`roles`): that
 * call stays an `mcp.read`. The typed browser tools reach beyond the desktop, so a call that is also one of these asks
 * once, naming them all: a page at a private or local address (`net.private`), a file from outside the workspace sent
 * to a page (`upload.outside`), a download saved outside it (`file.outside`), and attaching to the user's own signed-in
 * profile (`browser.cookies`, which no spawn grant answers: a child asks through its parent each time). The clipboard,
 * `kill_app`, recording, replay, session escalation and the two browser tools that leave the page also ask
 * `desktop.sensitive`, the same kind of class, so they ask on every call even in an approved child.
 */
export async function desktopMcpRequest(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string = process.cwd(),
	lookup?: HostLookup,
): Promise<PermissionRequest | undefined> {
	const tool = desktopTool(toolName);
	if (tool === undefined || mcpCallChange(toolName) === undefined) return undefined;
	const what = [`${toolName} ${JSON.stringify(input)}`];
	const also: ActionClass[] = [];
	const addresses: string[] = [];
	for (const raw of desktopUrls(toolName, input)) {
		const url = URL.canParse(raw) ? new URL(raw) : undefined;
		if (!url) continue;
		if (url.protocol === "about:") continue;
		const host = url && isHttpUrl(url) ? await classifyHost(url, lookup) : undefined;
		if (host?.kind === "public") continue;
		addresses.push(
			`The browser would open ${raw}, which is ${host ? "a private, local or unresolved address" : "not a web address"}.`,
		);
	}
	if (addresses.length > 0) {
		also.push("net.private");
		what.push(...addresses);
	}
	if (tool === "browser_set_input_files") {
		const outside = outsideWorkspace(strings(input.files), cwd);
		if (outside.length > 0) {
			also.push("upload.outside");
			what.push(...outside.map((file) => `Sends ${file} from outside the workspace to a page.`));
		}
	}
	if (tool === "browser_download" && typeof input.destination_root === "string") {
		const outside = outsideWorkspace([input.destination_root], cwd);
		if (outside.length > 0) {
			also.push("file.outside");
			what.push(`Saves a download in ${outside[0]}, outside the workspace.`);
		}
	}
	if (SENSITIVE_TOOLS.has(tool)) {
		also.push("desktop.sensitive");
		what.push(`${tool} is on the list that asks on every call, even inside an approved desktop child.`);
	}
	const strategy = input.strategy;
	if (
		tool === "browser_prepare" &&
		typeof strategy === "object" &&
		strategy !== null &&
		(strategy as { kind?: unknown }).kind === "existing_profile"
	) {
		also.push("browser.cookies");
		what.push("Attaches to your own signed-in browser profile: its pages, cookies and storage.");
	}
	return {
		action: "desktop.control",
		...(also.length > 0 ? { also } : {}),
		title: "Take control of the desktop?",
		what,
	};
}

/**
 * What the MCP workspace needs from its host, as narrow ports. The workspace imports nothing from the host package:
 * the host installs one implementation of each port at its composition root (`octocode/mcp-host/` in coding-agent),
 * and MCP code reaches them through the accessors below. A port that is not installed throws on first use, so a
 * missing installation fails loudly instead of falling back to a guess.
 *
 * Ports are installed in two groups so a command that never draws a screen (`octocode mcp list`) does not load the
 * renderers: `core` (identity, paths, output, trust, models, browser) and `view` (render, ui).
 */

import type { Component, Container, TUI } from "@octocodeai/octocode-tui";
import type { ImageLimits } from "@octocodeai/octocode-ai/utils/vision";
import type { TSchema } from "typebox";
import type { ToolAudit } from "@octocodeai/octocode-contracts/config";
import type { McpExposure, McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import type { McpCommandContext, McpKeybindings, McpRenderContext, McpTheme, McpToolDefinition } from "./host/types.ts";
import type { StdioLaunchWrapper } from "./client/transports/stdio-launch.ts";
import type { McpCallsPort } from "./host/calls.ts";

/** The host application's name, version and runtime. */
export interface McpIdentityPort {
	/** Command name shown in messages (`octocode`). */
	readonly appName: string;
	/** Folder name at the project level (`.octocode`). */
	readonly configDirName: string;
	readonly version: string;
	isBunBinary(): boolean;
	/** The folder the host package is installed in. */
	packageDir(): string;
}

/** Where optimized skill descriptions and MCP files live, by the scope of what they describe. */
interface McpContextOptimizationDirs {
	user: string;
	project?: { dir: string; root: string };
}

/** Folders the user added for the research server's readers: validated absolute realpaths, de-duplicated and sorted. */
export interface McpResearchRoots {
	roots: string[];
	/** One sentence per rejected or skipped entry, naming its source. */
	warnings: string[];
}

/** The host's configuration and state folders. */
export interface McpPathsPort {
	agentDir(): string;
	octocodeHome(env?: NodeJS.ProcessEnv): string;
	/** Config folders of other agents the host also reads, lowest precedence last; empty for an explicit home. */
	legacyConfigDirs(agentDir: string): string[];
	contextOptimizationDir(agentDir?: string): string;
	contextOptimizationDirs(cwd: string | undefined, agentDir?: string): McpContextOptimizationDirs;
	/** Workspace-local archive and output directories the model can read from a session started in a subfolder. */
	sessionRoots(cwd: string, env?: NodeJS.ProcessEnv): string[];
	/**
	 * The folders the user added for the research server, read live from the host's own sources (`env` is the process
	 * environment, whose `ALLOWED_PATHS` counts as one). A host without user-added folders omits it.
	 */
	researchRoots?(env?: NodeJS.ProcessEnv): McpResearchRoots;
	/**
	 * Every skill folder the host adds when it discovers the resources of a session in `cwd` (`resources_discover`), as
	 * absolute realpaths, known before then: only folders the session loads (a skill the user switched off stays out). A
	 * `${researchRoots}` launch names each whole, in place of the loaded skill folders inside it, so the launch is the
	 * same before and after discovery and starts with the session (`startup-gate.ts`). A host that omits it keeps such
	 * launches waiting for discovery.
	 */
	announcedSkillRoots?(context: { cwd: string; projectTrusted: boolean }): string[];
	/** Where running stdio servers' owner records live, so a later start can stop the groups of a dead owner; omitted: none are kept. */
	serverRecordsDir?(): string;
	/** The host's MCP configuration page, shown in Add MCP; a host without shipped docs omits it. */
	mcpDocsPath?(): string;
}

/** What `spillOutput` made of a text. */
interface McpSpilledOutput {
	text: string;
	truncated: boolean;
	file?: string;
}

/** Bounded model-facing output: text kept whole or saved to the session's output folder, and images fitted to the model. */
export interface McpOutputPort {
	/** The most characters one text part of a result may carry. */
	readonly textMaxChars: number;
	saveFullOutput(text: string, label: string): string | undefined;
	spillOutput(
		text: string,
		options: {
			label: string;
			maxBytes?: number;
			maxLines?: number;
			save?: (text: string, label: string) => string | undefined;
		},
	): McpSpilledOutput;
	capResultText(text: string, label: string): string;
	/** The most base64 characters of one image for a model with `limits`. */
	imageBudget(limits?: ImageLimits): number;
	/** Keeps a fitted image visible and saves its original; a text part explains what happened. */
	boundImagePart<T extends { type: "image"; data: string; mimeType: string }>(
		part: T,
		label: string,
		options?: { limits?: ImageLimits },
	): Promise<Array<T | { type: "text"; text: string }>>;
	/** `[tail note]` before the end of a captured stream. */
	tailNote(label: string, shown: number, total: number, file: string | undefined): string;
}

/** An image fitted to limits. `note` maps coordinates back when it was scaled down. */
/** The folder trust decision, for commands that run outside a session (a session reads `ctx.isProjectTrusted()`). */
export interface McpTrustPort {
	/** Whether the user trusted `cwd` (or a folder above it that covers it). */
	folderTrusted(cwd: string): boolean;
}

/** Per-server OAuth state storage with a lock shared across processes. */
export interface McpAuthBackend {
	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T;
}

/** Provider credentials and the OAuth file backend. */
export interface McpModelsPort {
	/** The token of a model provider outside a session, read like a session does; undefined when none. */
	storedProviderToken(agentDir: string, provider: string): Promise<string | undefined>;
	/** A lock-guarded file backend for credential content at `file`. */
	fileAuthBackend(file: string): McpAuthBackend;
}

/** Browser server support that depends on the permission system and the native browser. */
export interface McpBrowserPort {
	/** Whether the permission check asked `net.private` for `hostname:port` recently; undefined when it did not see the host. */
	mcpAsked(key: string): boolean | undefined;
}

/** Tool rows, as the host draws them. */
export interface McpRenderPort {
	/** Renders a model-facing template from the host's instructions folder. */
	instruction(name: string, values: Record<string, string | number | boolean | undefined>): string;
	toolHeader(
		theme: McpTheme,
		context: McpRenderContext,
		name: string,
		summary: string,
		options?: { lines?: string[]; meta?: string },
	): Component;
	resultBlock(
		theme: McpTheme,
		context: McpRenderContext,
		options: { summary: string; summaryColor?: string; body: string; max?: number; waits?: string },
	): Component;
	resultText(result: { content: Array<{ type: string; text?: string }> }): string;
	timingOf(details: unknown): { waits?: string };
	/** Wraps `execute` to record queue and check time for the row's timing line. */
	timedTool<TParams extends TSchema, TDetails, TState>(
		tool: McpToolDefinition<TParams, TDetails, TState>,
	): McpToolDefinition<TParams, TDetails, TState>;
	formatToolCallWithArgs(title: string, args: unknown, theme: McpTheme, expanded: boolean): string;
	getTextOutput(
		result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
		showImages: boolean,
	): string;
	/**
	 * Output text coloured by what it is: code by the file `path` the call named, a unified diff. Only the first
	 * `previewLines` lines are coloured when not `expanded`. Undefined when the text is neither (it stays plain).
	 */
	colorOutput(
		theme: McpTheme,
		text: string,
		options: { path?: string; expanded: boolean; previewLines: number },
	): string | undefined;
}

/** One page of the shared list → detail → action pattern: facts, one section of rows, notes and the key hints. */
interface McpPageOptions {
	title: string;
	facts?: Array<{ label: string; value: string }>;
	/** Problems, drawn in the error colour. */
	alerts?: string[];
	notes?: string[];
	heading: string;
	rows: Array<{
		id: string;
		name: string;
		detail?: string;
		badge?: string;
		tone?: "success" | "muted" | "warning" | "error";
	}>;
	/** Shown when there are no rows. */
	empty?: string;
	initialId?: string;
	/** What Enter does, for the key hint. */
	confirmLabel: string;
	/** What Escape does, for the key hint. */
	cancelLabel: string;
	/** Single keys reported with the highlighted row, each with the label its key hint shows. */
	keys?: ReadonlyArray<{ key: string; label: string }>;
	onKey?(key: string, id: string): void;
	onSelect(id: string): void;
	onHighlight(id: string): void;
	onCancel(): void;
}

/** The terminal view pieces of the `/mcp` manager. */
export interface McpUiPort {
	keyHint(keybinding: string, description: string): string;
	frame(theme: McpTheme, title: string, body: Component[], footer?: string): Container;
	renderClipped(content: Component, width: number): string[];
	/** The host's page component for `options`; it handles the arrow, Enter and Escape keys. */
	page(options: McpPageOptions): Component;
	/** The authorization-URL line with a copy action. */
	authUrl(tui: TUI, url: string): Component & { copy(): Promise<void> };
	/** Runs `run` against a view the host mounts for the command until `run` returns; failures are shown as errors. */
	runInView<V extends Component>(
		ctx: McpCommandContext,
		create: (tui: TUI, theme: McpTheme, keybindings: McpKeybindings) => V,
		run: (view: V) => Promise<void>,
	): Promise<void>;
}

/** Where a session runs, for the vendor switch: the host reads its settings (project settings only when trusted). */
export interface McpVendorPlace {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

/** The scope of a config file a vendor switch reaches: a project key switches only project files. */
type McpVendorScope = "global" | "project";

/** Other agents' config locations and the host's per-vendor switch (`/harness enable|disable <vendor>`). */
export interface McpVendorsPort {
	/** The user's home, where `~/.cursor/mcp.json` lives. */
	home(): string;
	/** Claude Code's user file: `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, else `~/.claude.json`. */
	claudeJsonPath(): string;
	/** Codex's home (`CODEX_HOME`, else `~/.codex`), or the reason `CODEX_HOME` cannot be used. */
	codexHome(): { dir: string } | { error: string };
	/** The repository root of `cwd` (the folder itself outside a repository). */
	repoRoot(cwd: string): string;
	/** Parses TOML text; throws on invalid input without quoting it. */
	parseToml(text: string): unknown;
	/**
	 * The vendor switch for one session place, read once: `vendorEnabled(vendor, scope)` says whether that vendor's files
	 * of `scope` load. `vendor` is a harness id (`octocode`, `agents`, `mcp-json`, `pi`, `claude`, `codex`, `cursor`).
	 */
	vendorSwitch(place: McpVendorPlace): (vendor: string, scope: McpVendorScope) => boolean;
}

/** MCP servers that enabled plugins declare, which a session registers beside the configured ones. */
export interface McpPluginsPort {
	/** The servers (named `plugin:<plugin>:<server>`) and the problems found reading them, for one place. */
	servers(place: McpVendorPlace): { servers: Array<{ name: string; config: McpServerConfig }>; errors: string[] };
}

/** One configured entry as the review port sees it. */
interface McpReviewEntry {
	name: string;
	config: McpServerConfig;
	source: string;
	scope?: string;
}

/**
 * The host's feature guard: which configured servers stay off until the user approves their exact launch. Optional:
 * without it every entry loads, so the package works alone. Never asked about a built-in (`default`) entry.
 */
export interface McpReviewPort {
	/** The names among `entries` that do not load, for a session in `cwd`. Must not throw: a fault loads everything. */
	withheld(entries: readonly McpReviewEntry[], cwd: string): ReadonlySet<string>;
	/**
	 * The static scan of one definition, as the review would rate it at load: before it is saved (Add MCP) the user sees
	 * the rating and the findings, worst first. Nothing is started or looked up. Must not throw.
	 */
	rate?(entry: McpReviewEntry, cwd: string): McpReviewRating;
}

/** A scan's result as a row of text: the rating word and one plain sentence per finding, worst first. */
export interface McpReviewRating {
	rating: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
	findings: string[];
}

/** The scope a tool switch is written for; the host picks the file (a project scope needs a trusted folder). */
export type McpToolWriteScope = "global" | "project";

/** One tool of a server as a new session declares it. */
export interface McpToolSwitchRow {
	name: string;
	/** The server's `toolExposure` entry for this exact name. */
	pin?: McpExposure;
	/** What a new session declares: the pin, else what the session reports, else the server's default. */
	state: McpExposure;
	/** What the running session declares; absent when it does not list the tool. */
	live?: McpExposure;
	audit?: ToolAudit;
}

/** A server's tool switches: its tools, who gets the server, and where a change is written. */
export interface McpToolSwitchView {
	name: string;
	/** The session lists this server's tools (it is connected). */
	connected: boolean;
	/** Every tool the session lists, then pinned tools it does not. */
	tools: McpToolSwitchRow[];
	/** `defaultActive`: in every agent's default tool selection, or only in agents whose `tools:` name it. */
	everyAgent: boolean;
	/** The exposure a tool without a pin gets from the server's own setting. */
	defaultState: McpExposure;
	/** Why a change cannot be saved; absent when it can. */
	blocked?: string;
	/** The file a change is written to, home shortened. */
	target?: string;
}

/**
 * Per-tool exposure pins, `defaultActive` and the server's `exposure`, written the way the host's other switch surfaces
 * write them (the web Tools panel). Optional: without it the `/mcp` tools page only inspects. Each write answers with
 * a line for the user and throws when it cannot be saved.
 */
export interface McpToolSwitchPort {
	view(place: McpVendorPlace, server: string, scope: McpToolWriteScope): McpToolSwitchView;
	/** `null` removes the pin. */
	pin(place: McpVendorPlace, server: string, scope: McpToolWriteScope, tool: string, pin: McpExposure | null): string;
	assign(place: McpVendorPlace, server: string, scope: McpToolWriteScope, everyAgent: boolean): string;
	setExposure(place: McpVendorPlace, server: string, scope: McpToolWriteScope, exposure: McpExposure): string;
}

/** Runs a stdio server inside the host's command sandbox (a server entry's `sandbox: true`); rejects when it cannot. */
export interface McpSandboxPort {
	wrapStdio: StdioLaunchWrapper;
}

export interface McpHostPorts {
	identity: McpIdentityPort;
	plugins: McpPluginsPort;
	paths: McpPathsPort;
	vendors: McpVendorsPort;
	output: McpOutputPort;
	trust: McpTrustPort;
	models: McpModelsPort;
	browser: McpBrowserPort;
	render: McpRenderPort;
	ui: McpUiPort;
	review: McpReviewPort;
	toolSwitch: McpToolSwitchPort;
	sandbox: McpSandboxPort;
	calls: McpCallsPort;
}

let installed: Partial<McpHostPorts> = {};

/** Installs ports; a later call replaces the ports it names and keeps the rest. Called at the host's composition root. */
export function installMcpHost(ports: Partial<McpHostPorts>): void {
	installed = { ...installed, ...ports };
}

function port<K extends keyof McpHostPorts>(name: K): McpHostPorts[K] {
	const found = installed[name];
	if (!found) throw new Error(`MCP host port "${name}" is not installed: call installMcpHost() before using MCP.`);
	return found;
}

export const hostIdentity = (): McpIdentityPort => port("identity");
export const hostPaths = (): McpPathsPort => port("paths");
export const hostPlugins = (): McpPluginsPort => port("plugins");
export const hostVendors = (): McpVendorsPort => port("vendors");
export const hostOutput = (): McpOutputPort => port("output");
export const hostTrust = (): McpTrustPort => port("trust");
export const hostModels = (): McpModelsPort => port("models");
export const hostBrowser = (): McpBrowserPort => port("browser");
export const hostRender = (): McpRenderPort => port("render");
export const hostUi = (): McpUiPort => port("ui");
/** The review port, or undefined when the host installed none. */
export const hostReview = (): McpReviewPort | undefined => installed.review;
/** The sandbox port, or undefined when the host installed none: an opted-in server then does not start. */
export const hostSandbox = (): McpSandboxPort | undefined => installed.sandbox;
/** The calls port, or undefined when the host installed none: a call then holds the turn until the server answers. */
export const hostCalls = (): McpCallsPort | undefined => installed.calls;
/** The tool switch port, or undefined when the host installed none. */
export const hostToolSwitch = (): McpToolSwitchPort | undefined => installed.toolSwitch;
/** The folder for stdio server owner records, or undefined when no paths port is installed or it names none. */
export const hostServerRecordsDir = (): string | undefined => installed.paths?.serverRecordsDir?.();

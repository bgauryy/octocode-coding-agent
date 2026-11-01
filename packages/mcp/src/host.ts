/**
 * What the MCP workspace needs from its host, as narrow ports. The workspace imports nothing from the host package:
 * the host installs one implementation of each port at its composition root (`octocode/mcp-host/` in coding-agent),
 * and MCP code reaches them through the accessors below. A port that is not installed throws on first use, so a
 * missing installation fails loudly instead of falling back to a guess.
 *
 * Ports are installed in two groups so a command that never draws a screen (`octocode mcp list`) does not load the
 * renderers: `core` (identity, paths, output, images, trust, models, browser) and `view` (render, ui).
 */

import type { Component, Container, SelectListTheme, TUI } from "@octocodeai/octocode-tui";
import type { ImageLimits } from "@octocodeai/octocode-ai/utils/vision";
import type { TSchema } from "typebox";
import type { McpCommandContext, McpKeybindings, McpRenderContext, McpTheme, McpToolDefinition } from "./host/types.ts";

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
	/** The command line that runs the bundled research CLI. */
	researchCliInvocation(kind: "research" | "native"): { command: string; prefix: string[] };
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
	/** `<agent state>/sessions`: one folder per session. Nothing is created. */
	sessionsRoot(env?: NodeJS.ProcessEnv): string;
	/**
	 * The folders the user added for the research server, read live from the host's own sources (`env` is the process
	 * environment, whose `ALLOWED_PATHS` counts as one). A host without user-added folders omits it.
	 */
	researchRoots?(env?: NodeJS.ProcessEnv): McpResearchRoots;
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
interface McpFittedImage {
	data: string;
	mimeType: string;
	note?: string;
}

/** Image decoding and resizing, which the host owns (it ships the worker). */
export interface McpImagePort {
	/** Resizes `bytes` to `limits`; null when the image cannot be decoded or fitted. */
	fit(bytes: Uint8Array, mimeType: string, limits: ImageLimits & { maxBytes: number }): Promise<McpFittedImage | null>;
}

/** Trust decisions for project configuration. */
export interface McpTrustPort {
	/** The directory decision `/trust` stored for `cwd` under `agentDir`. */
	directoryTrusted(agentDir: string, cwd: string): boolean;
	/** Whether the project's config files match the content trusted with `/trust`; undefined when no decision applies. */
	contentTrusted(ctx: { cwd: string; isProjectTrusted(): boolean }): boolean | undefined;
	/** Project MCP files that exist under `cwd`. */
	projectMcpFiles(cwd: string): string[];
	/**
	 * Starts an edit of a project MCP file that cannot add a command. The returned function, called after the edit,
	 * moves content trust to the edited files when the exact files were trusted before it; otherwise it does nothing.
	 */
	beginTrustPreservingEdit(root: string, file: string): () => void;
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
	toolHeader(
		theme: McpTheme,
		context: McpRenderContext,
		name: string,
		summary: string,
		options?: { lines?: string[] },
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
	/** The skill name of a call that reads exactly one loaded skill's instruction file. */
	skillNameOfRead(args: unknown, cwd: string): string | undefined;
	skillHeader(theme: McpTheme, context: McpRenderContext, name: string): Component;
	formatToolCallWithArgs(title: string, args: unknown, theme: McpTheme, expanded: boolean): string;
	getTextOutput(
		result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
		showImages: boolean,
	): string;
}

/** The terminal view pieces of the `/mcp` manager. */
export interface McpUiPort {
	keyHint(keybinding: string, description: string): string;
	frame(theme: McpTheme, title: string, body: Component[], footer?: string): Container;
	renderClipped(content: Component, width: number): string[];
	/** The select list's colours in the active theme. */
	selectListTheme(): SelectListTheme;
	/** The authorization-URL line with a copy action. */
	authUrl(tui: TUI, url: string): Component & { copy(): Promise<void> };
	/** Runs `run` against a view the host mounts for the command until `run` returns; failures are shown as errors. */
	runInView<V extends Component>(
		ctx: McpCommandContext,
		create: (tui: TUI, theme: McpTheme, keybindings: McpKeybindings) => V,
		run: (view: V) => Promise<void>,
	): Promise<void>;
}

export interface McpHostPorts {
	identity: McpIdentityPort;
	paths: McpPathsPort;
	output: McpOutputPort;
	images: McpImagePort;
	trust: McpTrustPort;
	models: McpModelsPort;
	browser: McpBrowserPort;
	render: McpRenderPort;
	ui: McpUiPort;
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
export const hostOutput = (): McpOutputPort => port("output");
export const hostImages = (): McpImagePort => port("images");
export const hostTrust = (): McpTrustPort => port("trust");
export const hostModels = (): McpModelsPort => port("models");
export const hostBrowser = (): McpBrowserPort => port("browser");
export const hostRender = (): McpRenderPort => port("render");
export const hostUi = (): McpUiPort => port("ui");

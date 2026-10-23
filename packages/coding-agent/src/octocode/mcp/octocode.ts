import { resolveMcpExposure } from "../../extensions/mcp/exposure.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Tool } from "@octocodeai/octocode-mcp";
import { getAgentDir, isBunBinary } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/index.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../../extensions/tool-search/tool.ts";
import { loadMcpConfig } from "../../extensions/mcp/config.ts";
import { type McpServerStatus, setMcpSessionStatus } from "../../extensions/mcp/status.ts";
import { notify } from "../shared/commands.ts";
import { envFlag, MCP_ENV } from "../shared/env.ts";
import { octocodeHome } from "../shared/home.ts";
import { OCTOCODE_SERVER, OCTOCODE_TOOL_PREFIX } from "../shared/octocode-tools.ts";
import { findManifest, packageRoot } from "../shared/package.ts";
import { visibleControls } from "../shared/sanitize.ts";
import { type Launch, OctocodeServer, type ServerStatus } from "./client.ts";
import { isDirectResearchTool } from "../shared/octocode-tools.ts";
import { octocodeToolDefinition, TurnBudget } from "./tools.ts";

/**
 * Octocode MCP (local code, LSP, GitHub and package registry research) runs on this extension's own MCP client
 * (`OctocodeServer`): it starts the `octocode-mcp` server at `session_start`, registers every tool the server lists as
 * `mcp__octocode__<name>` (the local research tools `direct`, the rest automatically exposed) and keeps the server's instructions for the prompt. A server named `octocode` in Octocode's
 * shared MCP configuration takes precedence, which is how users override or disable it: then
 * Octocode's MCP owns the server and this extension starts nothing.
 */
/** The npm package of the server this extension runs. */
const MCP_PACKAGE = "octocode-mcp";

/** The `octocode-mcp` range this package's `package.json` depends on (the one source of the version this extension runs). */
function octocodeMcpRange(): string {
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const range = manifest.dependencies?.[MCP_PACKAGE];
	if (!range) throw new Error("package.json has no octocode-mcp dependency");
	return range;
}

/**
 * The octocode-mcp releases this extension runs, as an npx spec: the `package.json` dependency range, so installing or
 * updating the extension and the npx fallback fetch the same newest compatible server; in this monorepo `dev setup`
 * resolves the dependency to the workspace build (`packages/octocode-mcp`).
 */
export const OCTOCODE_MCP_SPEC = `${MCP_PACKAGE}@${octocodeMcpRange()}`;

/** The server process: the installed octocode-mcp bin under this Node, else the newest npm release through npx. */
export function octocodeLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	entry = octocodeMcpEntry(),
	skillDirectories: readonly string[] = [],
): Launch {
	// Loaded skills may live outside the workspace; their references resolve inside the same skill directories.
	// Tokens (GITHUB_TOKEN, …) need no forwarding: the server inherits this process's environment.
	const allowed = [...new Set([cwd, octocodeHome(env), ...skillDirectories])].join(",");
	if (!entry && OCTOCODE_MCP_SPEC.includes("@file:"))
		throw new Error(
			"The local octocode-mcp build is missing. Build the linked package before starting Octocode research.",
		);
	const command = entry
		? { command: isBunBinary ? "node" : process.execPath, args: [entry] }
		: { command: "npx", args: ["-y", OCTOCODE_MCP_SPEC] };
	return { ...command, cwd, env: { WORKSPACE_ROOT: cwd, ALLOWED_PATHS: allowed } };
}

/**
 * The longest the first prompt waits for a connect in progress, so the server's instructions are in that request. A
 * failed connect or the user's Esc ends the wait at once; a slower start (a first `npx` download) joins a later prompt.
 */
const CONNECT_WAIT_MS = 10_000;

/** Whether the Octocode MCP server is switched on for this process (`OCTOCODE_MCP=0` turns it off). */
const octocodeMcpEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => envFlag(env, MCP_ENV, true);

/**
 * The `octocode` entry from the shared MCP loader (global, then trusted project files), which
 * takes precedence over automatic registration; undefined when no valid entry exists.
 */
export function configuredOctocodeServer(
	cwd: string,
	projectTrusted: boolean,
	agentDir = getAgentDir(),
): { enabled?: unknown } | undefined {
	return loadMcpConfig({ agentDir, cwd, projectTrusted }).servers.find((entry) => entry.name === OCTOCODE_SERVER)
		?.config;
}

/** Who runs the `octocode` server: the user (an `octocode` entry in `mcp.json`, through Octocode's MCP), this extension, or nobody. */
export type OctocodeOwner = { by: "user"; enabled: boolean } | { by: "extension" } | { by: "off" };

/**
 * The Octocode server for a session, on this extension's MCP client: started at `session_start`, its tools registered
 * with Octocode, its instructions kept for the prompt, closed at `session_shutdown`.
 */
export class OctocodeMcp {
	private readonly server: OctocodeServer;
	/** What is registered with Octocode under each tool name; Octocode cannot unregister, so a withdrawn tool is registered hidden. */
	private catalogTools: readonly Tool[] = [];
	private readonly registered = new Map<string, { tool: Tool; definition: ToolDefinition }>();
	private readonly hidden = new Set<string>();
	private ctx: ExtensionContext | undefined;
	/** The text this turn's results have put in the context; `registerOctocodeMcp` resets it at every `turn_start`. */
	readonly turn = new TurnBudget();
	/** Who ran the server when the session started. */
	private owned: OctocodeOwner = { by: "off" };

	private readonly env: NodeJS.ProcessEnv;
	private readonly connectWaitMs: number;
	private readonly enabled: boolean;
	private readonly skillDirectories: (() => string[]) | undefined;
	private launchedSkillDirectories: string[] = [];
	private readonly onStatus: (() => void) | undefined;
	private readonly ensureDiscovery: ((ctx: ExtensionContext | undefined) => void) | undefined;

	private readonly pi: Pick<ExtensionAPI, "registerTool"> & Partial<Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">>;
	constructor(
		pi: Pick<ExtensionAPI, "registerTool"> & Partial<Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">>,
		options: {
			env?: NodeJS.ProcessEnv;
			version?: string;
			launch?: (cwd: string) => Launch;
			connectWaitMs?: number;
			enabled?: boolean;
			skillDirectories?: () => string[];
			onStatus?: () => void;
			/** Called when deferred tools register, so the host can activate discovery. */
			ensureDiscovery?: (ctx: ExtensionContext | undefined) => void;
		} = {},
	) {
		this.pi = pi;
		this.enabled = options.enabled !== false;
		this.onStatus = options.onStatus;
		this.ensureDiscovery = options.ensureDiscovery;

		this.env = options.env ?? process.env;
		this.connectWaitMs = options.connectWaitMs ?? CONNECT_WAIT_MS;
		this.skillDirectories = options.launch ? undefined : options.skillDirectories;
		this.server = new OctocodeServer({
			launch:
				options.launch ??
				((cwd) => {
					this.launchedSkillDirectories = this.skillDirectories?.() ?? [];
					return octocodeLaunch(cwd, this.env, undefined, this.launchedSkillDirectories);
				}),
			clientInfo: { name: "octocodecode", version: options.version ?? "0" },
			onTools: (tools, instructions) => this.register(tools, instructions),
			onFailure: (message) => this.notifyFailure(message),
			onStatus: () => this.onStatus?.(),
			onRefreshFailure: (message) =>
				this.notify(
					`Octocode MCP could not refresh its tool list: ${message}\nTools it added since may be missing this session. See /mcp.`,
				),
		});
	}

	/** The user's `mcp.json` entry wins; else this extension runs the server unless `OCTOCODE_MCP=0`. */
	owner(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): OctocodeOwner {
		if (!this.enabled) return { by: "off" };
		const configured = configuredOctocodeServer(ctx.cwd, ctx.isProjectTrusted?.() ?? false);
		if (configured) return { by: "user", enabled: configured.enabled !== false };
		return { by: octocodeMcpEnabled(this.env) ? "extension" : "off" };
	}

	/** Starts the server for this session's folder (without waiting), or stops it when the session has none to run. */
	async start(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		this.owned = this.owner(ctx);
		if (this.owned.by === "extension") this.server.start(ctx.cwd);
		else await this.server.close();
		this.onStatus?.();
	}

	/** Waits for the server to connect (see CONNECT_WAIT_MS); false when it is not connected. */
	async ready(ctx: ExtensionContext): Promise<boolean> {
		this.ctx = ctx;
		// Extension-discovered skills arrive after session_start. Refresh roots before their first retrieval.
		if (
			this.owned.by === "extension" &&
			this.skillDirectories &&
			!isDeepStrictEqual(this.launchedSkillDirectories, this.skillDirectories())
		) {
			await this.server.close();
			this.server.start(ctx.cwd);
		}
		return this.server.ready(this.connectWaitMs, ctx.signal);
	}

	/** The server's `initialize` instructions (how its tools work together), sanitized: the server's text is not trusted. */
	get instructions(): string | undefined {
		const text = this.server.instructions;
		return text ? visibleControls(text).trim() || undefined : undefined;
	}

	/** Stops the server and starts it again for this session, whatever state it was in. */
	async restart(ctx: ExtensionContext): Promise<ServerStatus> {
		this.ctx = ctx;
		await this.server.restart(ctx.cwd);
		return this.server.status();
	}

	updateModel(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (this.status().state === "connected") this.register(this.catalogTools, this.server.instructions);
	}

	status(): ServerStatus {
		return this.server.status();
	}

	/** Whether Octocode's local readers are missing for good this session: the server is off, disabled or failed. */
	readersUnavailable(): boolean {
		if (this.owned.by === "off") return true;
		if (this.owned.by === "user") return !this.owned.enabled;
		return this.status().state === "failed";
	}

	sessionStatus(): McpServerStatus[] {
		if (this.owned.by === "user") return [];
		const status = this.status();
		return [{
			name: OCTOCODE_SERVER,
			enabled: this.owned.by === "extension",
			state: this.owned.by === "off" ? "disabled" : status.state,
			exposure: "auto",
			toolCount: status.tools,
			source: "built-in Octocode",
			scope: "extension",
		}];
	}

	/** `/mcp`: what runs the server and how it is doing; the first line is the summary. */
	describe(): string {
		const owner = this.owned;
		if (owner.by === "user")
			return `Octocode MCP: your own \`octocode\` server from mcp.json (${owner.enabled ? "Octocode's MCP, see /mcp" : "disabled there"})`;
		if (owner.by === "off")
			return this.enabled ? `Octocode MCP: off (${MCP_ENV}=0)` : "Octocode MCP: disabled for this session";
		const status = this.server.status();
		const server = status.serverName ? `${status.serverName} ${status.serverVersion ?? ""}`.trim() : "octocode-mcp";
		switch (status.state) {
			case "connected":
				return `Octocode MCP: connected (${server}, ${status.tools} tools, pid ${status.pid ?? "?"})${status.clientError ? `\nLast client error: ${status.clientError}` : ""}`;
			case "connecting":
				return "Octocode MCP: connecting…";
			case "failed":
				return `Octocode MCP: failed to start: ${status.error ?? "unknown error"}\nRetry with /mcp reconnect octocode.`;
			case "disconnected":
				return `Octocode MCP: stopped: ${status.error ?? "the server exited"}\nThe next tool call starts it again once; or run /mcp reconnect octocode.`;
			default:
				return "Octocode MCP: not started";
		}
	}

	/** Stops the server and its process tree. */
	async close(): Promise<void> {
		this.ctx = undefined;
		await this.server.close();
	}

	/** Registers every listed tool with Octocode, and withdraws the ones the server no longer lists. */
	private register(tools: readonly Tool[], instructions: string | undefined): void {
		this.catalogTools = tools;
		// Local research tools stay direct (`octocodeToolDefinition`); the rest wait for tool_search when it is available.
		const discovery = this.pi.getAllTools?.().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools) ?? false;
		const exposure = resolveMcpExposure("auto", tools, this.ctx?.model, discovery, true) as "direct" | "deferred";
		const namespace = {
			name: OCTOCODE_TOOL_PREFIX.replace(/__$/, ""),
			...(instructions ? { instructions: visibleControls(instructions).trim() } : {}),
		};
		const listed = new Set<string>();
		let indirect = false;
		for (const tool of tools) {
			const name = `${OCTOCODE_TOOL_PREFIX}${tool.name}`;
			listed.add(name);
			const previous = this.registered.get(name);
			// Octocode rebuilds the complete registry per registration. A reconnect or an unrelated tool change needs no rebuild.
			if (
				previous &&
				isDeepStrictEqual(previous.tool, tool) &&
				isDeepStrictEqual(previous.definition.namespace, namespace) &&
				(previous.definition.exposure === exposure || isDirectResearchTool(name))
			) {
				if (this.hidden.delete(name)) this.pi.registerTool(previous.definition);
				continue;
			}
			this.hidden.delete(name);
			const definition = octocodeToolDefinition(tool, {
				prefix: OCTOCODE_TOOL_PREFIX,
				exposure,
				namespace,
				call: (name, args, signal) => this.server.call(name, args, signal),
				budget: this.turn,
			});
			this.registered.set(definition.name, { tool, definition });
			this.pi.registerTool(definition);
			if (previous?.definition.exposure === "direct" && definition.exposure !== "direct") {
				const active = this.pi.getActiveTools?.();
				if (active) this.pi.setActiveTools?.(active.filter((tool) => tool !== name));
			}
		}
		for (const { definition } of this.registered.values()) {
			if (!this.hidden.has(definition.name) && definition.exposure !== "direct") indirect = true;
		}
		// Deferred tools need discovery before the model can call them.
		if (indirect) this.ensureDiscovery?.(this.ctx);
		for (const [name, { definition }] of this.registered) {
			if (listed.has(name) || this.hidden.has(name)) continue;
			this.hidden.add(name);
			this.pi.registerTool({ ...definition, exposure: "hidden" });
		}
	}

	private notifyFailure(message: string): void {
		this.notify(
			`Octocode MCP failed to start: ${message}\nThe model has no Octocode tools this session. See /mcp.`,
		);
	}

	private notify(text: string): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		try {
			notify(ctx.ui, text, "warning");
		} catch {
			// The session ended before the server gave up.
		}
	}
}

/**
 * `/mcp reconnect octocode`: restarts the server this extension runs. A server the user's `mcp.json` runs, or none, is
 * not Octocode's to restart. Returns the state to show, or undefined once connected.
 */
export function reconnectOctocodeMcp(mcp: Pick<OctocodeMcp, "describe" | "owner" | "restart">) {
	return async (ctx: ExtensionContext): Promise<string | undefined> => {
		if (mcp.owner(ctx).by !== "extension") return `${mcp.describe()}\nNothing to restart here.`;
		const result = await mcp.restart(ctx);
		return result.state === "connected" ? undefined : mcp.describe();
	};
}

/**
 * Wires the Octocode server to the session: its client starts at `session_start` (`OctocodeMcp.start` decides whether
 * this extension or the user's `mcp.json` runs it) and closes at `session_shutdown`.
 */
export function registerOctocodeMcp(
	pi: ExtensionAPI,
	version?: string,
	enabled = true,
	onReaders?: (unavailable: boolean) => void,
): OctocodeMcp {
	const syncReader = fallbackReader(pi);
	const mcp = new OctocodeMcp(pi, {
		...(version ? { version } : {}),
		enabled,
		onStatus: () => {
			setMcpSessionStatus(pi.events, "native", mcp.sessionStatus());
			// The file tool credits only reads; without Octocode's local readers, core `read` must stand in.
			const unavailable = mcp.readersUnavailable();
			syncReader(unavailable);
			onReaders?.(unavailable);
		},
		skillDirectories: () => pi.getSkillDirectories(),
		ensureDiscovery: () => activateDiscovery(pi),
	});
	pi.on("session_start", async (_event, ctx) => mcp.start(ctx));
	pi.on("model_select", (_event, ctx) => mcp.updateModel(ctx));
	pi.on("session_shutdown", async () => {
		await mcp.close();
		setMcpSessionStatus(pi.events, "native", []);
	});
	pi.on("turn_start", async () => mcp.turn.reset());
	return mcp;
}

/**
 * Keeps core `read` active while Octocode's local readers are unavailable, so an existing file can still be read before
 * the file tool changes it. It removes `read` again only if it was the one that added it: a `read` the user turned on
 * stays. While the server is still connecting nothing changes, so the declared tools (and the cached prefix) hold.
 */
export function fallbackReader(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "getAllTools">) {
	let added = false;
	return (unavailable: boolean): void => {
		try {
			const active = pi.getActiveTools();
			if (unavailable && !active.includes("read") && pi.getAllTools().some((tool) => tool.name === "read")) {
				pi.setActiveTools([...active, "read"]);
				added = true;
			} else if (!unavailable && added) {
				pi.setActiveTools(active.filter((tool) => tool !== "read"));
				added = false;
			}
		} catch {
			// The session is shutting down or not bound yet; the next status change retries.
		}
	};
}

/** Activate native discovery for deferred tools when the discovery tool is registered. */
function activateDiscovery(pi: ExtensionAPI): void {
	try {
		const active = pi.getActiveTools();
		if (active.includes(TOOL_SEARCH_TOOL_NAME) || !pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools)) return;
		pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
	} catch {
		// The session is shutting down or not bound yet; the next registration retries.
	}
}

/** Absolute path of the bundled octocode-mcp bin (its `exports` hide package.json, so walk up from the entry). */
function octocodeMcpEntry(): string | undefined {
	try {
		const found = findManifest(path.dirname(fileURLToPath(import.meta.resolve(MCP_PACKAGE))), MCP_PACKAGE, 4);
		const bin = typeof found?.manifest.bin === "string" ? found.manifest.bin : found?.manifest.bin?.[MCP_PACKAGE];
		return found && bin ? path.join(found.dir, bin) : undefined;
	} catch {
		// Not installed next to the extension.
	}
	return undefined;
}

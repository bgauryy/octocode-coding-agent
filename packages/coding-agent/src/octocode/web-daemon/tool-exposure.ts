/**
 * The Tools panel of the configuration page: what a session declares of each tool (`direct`, `deferred`, `hidden`),
 * what decided it, and the pin that fixes it. Pins are read from the files a new session reads and written where
 * `/mcp exposure` and the Harness panel write (`mcp.json` for MCP tools, the settings key `nativeToolExposure` for
 * native ones). What a running session declares comes from that session and never changes with a pin: the declared set
 * is part of its cached prompt, so a pin applies from the next session.
 */

import path from "node:path";
import {
	NATIVE_PINNABLE_TOOLS,
	ToolExposureRowSchema,
	type ToolExposureGroup,
	type ToolExposureList,
	type ToolExposureRow,
	type ToolPinCommand,
} from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import type { AttachToolStates } from "@octocodeai/octocode-contracts/daemon";
import { recentlyUsed } from "../../../../common/src/recent-use.ts";
import type { ConfigAuditEntry } from "../../../../db/src/api.ts";
import { isEnabled, currentMcpToolStates } from "../../../../mcp/src/api.ts";
import { loadMcpServers } from "../../configuration/adapters/mcp.ts";
import { writeSettingsKey } from "../../configuration/settings-write.ts";
import type { ConfigContext } from "../../configuration/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";
import { NEXT_SESSION, pinMcpTool, UnknownMcpServerError } from "../../configuration/adapters/mcp-pins.ts";
import { ConfigWriteError } from "./config-write.ts";

/** Each MCP server's tool states as a running session reports them. */
type LiveMcpStates = NonNullable<AttachToolStates["mcp"]>;

/** The running session's native tools: every registered name, and how each deferrable one was declared (true: deferred). */
export interface NativeToolsLive {
	names: readonly string[];
	declared: ReadonlyMap<string, boolean>;
}

export interface ToolExposureOptions {
	agentDir: string;
	/** The workspace root the host resolved from a `repoId`; absent: global configuration only. */
	cwd?: string;
	/** Home folder other tools' files are read from; tests pass a temporary one. */
	home?: string;
	/** Present in a session's own page only. */
	native?: () => NativeToolsLive;
	/**
	 * The session's MCP tool states; default: the MCP registry's, which a process without a session does not have. The
	 * daemon passes what an attached session answered.
	 */
	mcp?: () => LiveMcpStates | undefined;
}

export interface ToolPinOptions extends ToolExposureOptions {
	/** Who is acting, for the audit entry, such as `web:<daemon instance>`. */
	actor: string;
	/** Receives one entry per attempt. It must not throw; the write does not depend on it. */
	audit?: (entry: ConfigAuditEntry) => void;
}

const PINNABLE: ReadonlySet<string> = new Set(NATIVE_PINNABLE_TOOLS);

function open(options: ToolExposureOptions) {
	const trusted = options.cwd !== undefined && resolveFolderTrust(options.cwd).state === "trusted";
	const cwd = options.cwd ?? options.agentDir;
	const settings = SettingsManager.create(cwd, options.agentDir, { projectTrusted: trusted });
	const ctx: ConfigContext = {
		cwd,
		agentDir: options.agentDir,
		settings,
		projectTrusted: trusted,
		...(options.home ? { home: options.home } : {}),
	};
	return { trusted, settings, ctx };
}

/** A row whose name the page could not send back (a control character) is left out, so one odd tool does not hide the panel. */
const valid = (rows: ToolExposureRow[]): ToolExposureRow[] =>
	rows.filter((row) => Value.Check(ToolExposureRowSchema, row)).slice(0, 2000);

/**
 * The native tools. A deferrable one shows what the session declared when it registered the tool; without a session,
 * what a new one would declare: its pin, else deferred under `mcpExposure: "recent"` unless the workspace called it in
 * the last 24 hours (the record a session reads, under the key `native/<tool>`).
 */
function nativeGroup(ctx: ConfigContext, setting: string, live: NativeToolsLive | undefined): ToolExposureGroup {
	const pins: Record<string, unknown> = ctx.settings.getSettings().nativeToolExposure ?? {};
	const recent = setting === "recent";
	const inUse = recent ? recentlyUsed(path.join(ctx.agentDir, "tool-use.json"), ctx.cwd) : new Set<string>();
	const rows = NATIVE_PINNABLE_TOOLS.map((name): ToolExposureRow => {
		const saved = pins[name];
		const pin = saved === "direct" || saved === "deferred" ? saved : undefined;
		const declared = live?.declared.get(name);
		const predicted = pin ?? (recent && !inUse.has(`native/${name}`) ? "deferred" : "direct");
		const state = declared === undefined ? predicted : declared ? "deferred" : "direct";
		return {
			name,
			...(pin ? { pin } : {}),
			state,
			decidedBy: pin === state ? "pin" : recent ? "recent" : "default",
		};
	});
	const core = (live?.names ?? [])
		.filter((name) => !PINNABLE.has(name))
		.map((name): ToolExposureRow => ({ name, state: "direct", decidedBy: "core" }));
	return { kind: "native", name: "native", tools: valid([...rows, ...core]), pinnable: true };
}

/**
 * One group per enabled configured server. Tools and their state come from the running session; a pin for a tool the
 * session does not list (no session, or the server is not connected) is still shown, so it can be removed.
 */
function mcpGroups(ctx: ConfigContext, live: LiveMcpStates | undefined): ToolExposureGroup[] {
	const configured = loadMcpServers(ctx).servers.filter((entry) => isEnabled({ entry }));
	const groups = configured.map((entry): ToolExposureGroup => {
		const session = live?.find((server) => server.server === entry.name);
		const pins = entry.config.toolExposure ?? {};
		const rows = (session?.tools ?? []).map((tool): ToolExposureRow => {
			const pin = pins[tool.name];
			return { name: tool.name, ...(pin ? { pin } : {}), state: tool.state, decidedBy: tool.decidedBy };
		});
		const listed = new Set(rows.map((row) => row.name));
		for (const [name, pin] of Object.entries(pins))
			if (!name.includes("*") && !listed.has(name)) rows.push({ name, pin, state: pin, decidedBy: "pin" });
		const note = !live
			? "No session is running here, so only pinned tools are listed. Open this page from a session (/web) to see every tool."
			: !session
				? "The running session does not use this server."
				: session.connected
					? undefined
					: "Not connected in the running session, so only pinned tools are listed.";
		return { kind: "mcp", name: entry.name, tools: valid(rows), pinnable: true, ...(note ? { note } : {}) };
	});
	const names = new Set(configured.map((entry) => entry.name));
	const unsaved = (live ?? [])
		.filter((server) => !names.has(server.server))
		.map((server): ToolExposureGroup => ({
			kind: "mcp",
			name: server.server,
			tools: valid(server.tools.map((tool) => ({ ...tool }))),
			pinnable: false,
			note: "Not in a configuration file a pin can be saved to.",
		}));
	return [...groups, ...unsaved].slice(0, 499);
}

/** The native tools, then every enabled MCP server, read afresh each call. Connects nothing. */
export async function listToolExposure(options: ToolExposureOptions, message?: string): Promise<ToolExposureList> {
	const { trusted, ctx } = open(options);
	const configured = ctx.settings.getSettings().mcpExposure ?? SETTINGS_DEFAULTS.mcpExposure;
	const setting = configured.slice(0, 64) || SETTINGS_DEFAULTS.mcpExposure;
	const native = options.native?.();
	const mcp = (options.mcp ?? currentMcpToolStates)();
	return {
		setting,
		live: native !== undefined || mcp !== undefined,
		groups: [nativeGroup(ctx, setting, native), ...mcpGroups(ctx, mcp)],
		...(options.cwd !== undefined ? { workspace: { trusted } } : {}),
		...(message ? { message: message.slice(0, 500) } : {}),
	};
}

async function apply(command: ToolPinCommand, options: ToolExposureOptions): Promise<string> {
	const workspace = command.scope === "workspace";
	if (workspace && options.cwd === undefined)
		throw new ConfigWriteError(400, "Choose a workspace to pin a tool in it.", "no-workspace");
	const { trusted, settings, ctx } = open(options);
	if (workspace && !trusted)
		throw new ConfigWriteError(
			403,
			"This workspace is not trusted, so its pins cannot be changed. Trust it with /trust in a terminal session.",
			"untrusted",
		);
	const scope = workspace ? "project" : "global";
	const done = command.pin === null ? `Removed the pin of ${command.tool}.` : `Pinned ${command.tool} ${command.pin}.`;
	if (command.kind === "native") {
		// A file that did not parse is read as empty: writing now would replace it, so the write is refused instead.
		if (settings.drainErrors().some((error) => error.scope === scope))
			throw new ConfigWriteError(
				409,
				`The ${command.scope} settings file is invalid, so it was not changed. Fix it in a terminal first.`,
				"invalid-file",
			);
		try {
			await writeSettingsKey(ctx, scope, `nativeToolExposure.${command.tool}`, command.pin ?? undefined);
		} catch {
			throw new ConfigWriteError(500, `The ${command.scope} settings file could not be written.`, "write");
		}
		return `${done} ${NEXT_SESSION}`;
	}
	try {
		pinMcpTool(ctx, scope, command.server, command.tool, command.pin);
	} catch (error) {
		if (error instanceof UnknownMcpServerError) throw new ConfigWriteError(404, "Unknown MCP server.", "unknown");
		// The reason can quote the file, so the reply keeps fixed words.
		throw new ConfigWriteError(500, "The MCP configuration file could not be written.", "write");
	}
	return `${done} ${NEXT_SESSION}`;
}

/** Pins or unpins one tool and answers with the fresh list. Throws `ConfigWriteError` for a refusal. */
export async function pinTool(command: ToolPinCommand, options: ToolPinOptions): Promise<ToolExposureList> {
	const entry: ConfigAuditEntry = {
		at: Date.now(),
		actor: options.actor,
		action: "tool.pin",
		target: command.kind === "native" ? `native:${command.tool}` : `mcp:${command.server}/${command.tool}`,
		scope: command.scope,
		afterKind: command.pin ?? "unpinned",
		outcome: "failed",
	};
	let message: string;
	try {
		message = await apply(command, options);
		entry.outcome = "ok";
	} catch (error) {
		if (error instanceof ConfigWriteError) {
			entry.outcome = error.status >= 500 ? "failed" : "refused";
			entry.errorCode = error.code;
		} else entry.errorCode = "write";
		throw error;
	} finally {
		try {
			options.audit?.(entry);
		} catch {
			// The audit is best effort: a missing database must not undo or hide a change that was made.
		}
	}
	return listToolExposure(options, message);
}

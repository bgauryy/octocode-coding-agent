/**
 * The Harness panel of the configuration page. Rows and switches come from the configuration catalog that
 * `/settings` and `octocode configuration` use, so the page, the terminal and the CLI list the same ids and write
 * the same files: settings `toggles` for harnesses, skills, hooks, plugins and extensions, `mcp.json` for MCP servers.
 * Other tools' files are never written. Running sessions apply a switch as `/settings` says (`appliesWhen`).
 */

import {
	HARNESS_ROW_KINDS,
	HarnessIdSchema,
	type HarnessList,
	type HarnessRow,
	type HarnessRowKind,
	type HarnessSwitchCommand,
} from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import type { ConfigAuditEntry } from "../../../../db/src/api.ts";
import { createConfiguration, type ConfigEntry } from "../../configuration/index.ts";
import { configDiscovery } from "../../core/discovery/service.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";
import { ConfigWriteError } from "./config-write.ts";

export interface HarnessConfigOptions {
	agentDir: string;
	/** The workspace root the daemon resolved from a `repoId`; absent: global switches only. */
	cwd?: string;
	/** Home folder other tools' files are read from; tests pass a temporary one. */
	home?: string;
}

export interface HarnessWriteOptions extends HarnessConfigOptions {
	/** Who is acting, for the audit entry, such as `web:<daemon instance>`. */
	actor: string;
	/** Receives one entry per attempt. It must not throw; the write does not depend on it. */
	audit?: (entry: ConfigAuditEntry) => void;
}

const KINDS: ReadonlySet<string> = new Set(HARNESS_ROW_KINDS);
const isRowKind = (kind: string): kind is HarnessRowKind => KINDS.has(kind);

export function open(options: HarnessConfigOptions) {
	const trusted = options.cwd !== undefined && resolveFolderTrust(options.cwd).state === "trusted";
	const cwd = options.cwd ?? options.agentDir;
	const settings = SettingsManager.create(cwd, options.agentDir, { projectTrusted: trusted });
	const catalog = createConfiguration({
		cwd,
		agentDir: options.agentDir,
		settings,
		projectTrusted: trusted,
		...(options.home ? { home: options.home } : {}),
	});
	return { trusted, settings, catalog };
}

function toRow(entry: ConfigEntry & { kind: HarnessRowKind }): HarnessRow {
	return {
		id: entry.id,
		kind: entry.kind,
		label: entry.label.slice(0, 512),
		...(entry.detail ? { detail: entry.detail.slice(0, 1024) } : {}),
		on: entry.value === true,
		setBy: entry.setBy === "project" ? "workspace" : entry.setBy === "global" ? "global" : "default",
		...(entry.locked ? { locked: entry.locked.slice(0, 512) } : {}),
		appliesWhen: entry.appliesWhen,
	};
}

/** Every switch `/harness` shows, grouped by kind in `HARNESS_ROW_KINDS` order. Reads the folders afresh each call. */
export async function listHarness(options: HarnessConfigOptions, message?: string): Promise<HarnessList> {
	const { trusted, catalog } = open(options);
	// A new discovery pass: the daemon outlives file changes that a session would pick up on `/reload`.
	const entries = await configDiscovery.pass(() => catalog.list({ kinds: HARNESS_ROW_KINDS }));
	// A row whose id the page could not send back (a skill path with a control character) stays in `/harness` only, so
	// one odd file name does not hide the whole panel.
	const rows = entries.filter(
		(entry): entry is ConfigEntry & { kind: HarnessRowKind } =>
			isRowKind(entry.kind) && entry.valueType.type === "toggle" && Value.Check(HarnessIdSchema, entry.id),
	);
	return {
		rows: HARNESS_ROW_KINDS.flatMap((kind) => rows.filter((entry) => entry.kind === kind)).map(toRow),
		...(options.cwd !== undefined ? { workspace: { trusted } } : {}),
		...(message ? { message: message.slice(0, 500) } : {}),
	};
}

async function apply(command: HarnessSwitchCommand, options: HarnessConfigOptions): Promise<string> {
	const workspace = command.scope === "workspace";
	if (workspace && options.cwd === undefined)
		throw new ConfigWriteError(400, "Choose a workspace to change its switches.", "no-workspace");
	const { trusted, settings, catalog } = open(options);
	if (workspace && !trusted)
		throw new ConfigWriteError(
			403,
			"This workspace is not trusted, so its switches cannot be changed. Trust it with /trust in a terminal session.",
			"untrusted",
		);
	const scope = workspace ? "project" : "global";
	// A file that did not parse is read as empty: writing now would replace it, so the write is refused instead.
	if (settings.drainErrors().some((error) => error.scope === scope))
		throw new ConfigWriteError(
			409,
			`The ${command.scope} settings file is invalid, so it was not changed. Fix it in a terminal first.`,
			"invalid-file",
		);
	const result = await configDiscovery.pass(async () => {
		const known = isRowKind(command.id.split(":")[0] ?? "") && (await catalog.get(command.id)) !== undefined;
		if (!known) throw new ConfigWriteError(404, "Unknown switch.", "unknown");
		return catalog.apply({ verb: command.on ? "enable" : "disable", id: command.id, scope });
	});
	if (result.status === "refused") throw new ConfigWriteError(409, result.reason.slice(0, 500), "refused");
	await settings.flush();
	if (settings.drainErrors().length > 0)
		throw new ConfigWriteError(500, `The ${command.scope} settings file could not be written.`, "write");
	return result.message;
}

/** Audit rows never store file paths: an id that holds one (a duplicated skill, a hook file, a plugin folder) keeps only its kind. */
function auditTarget(id: string): string {
	return /[/\\]/.test(id) ? (id.split(":")[0] ?? "") : id;
}

/** Switches one row on or off and answers with the fresh list. Throws `ConfigWriteError` for a refusal. */
export async function switchHarness(command: HarnessSwitchCommand, options: HarnessWriteOptions): Promise<HarnessList> {
	const entry: ConfigAuditEntry = {
		at: Date.now(),
		actor: options.actor,
		action: "harness.toggle",
		target: auditTarget(command.id),
		scope: command.scope,
		afterKind: command.on ? "on" : "off",
		outcome: "failed",
	};
	// The audit records the write; reading the fresh list afterwards is the reply, not part of the change.
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
	return listHarness(options, message);
}

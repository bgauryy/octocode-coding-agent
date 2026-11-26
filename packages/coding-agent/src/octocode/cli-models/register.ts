import fs from "node:fs";
import path from "node:path";
import { hostTrust } from "../../../../mcp/src/api.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { ExternalModelEntry } from "../../core/settings-schema/external-models.ts";
import { type AgentItemInput, agentItem, agentPinHash } from "../guard/items.ts";
import { recordGate } from "../guard/registry.ts";
import { type GuardOptions, gate, scopeFor } from "../guard/store.ts";
import { forgetRunner, type RunnerState } from "../external/runner-status.ts";
import { attachBackend } from "./attach.ts";
import { createRouteBackend } from "./backend.ts";
import type { CliModelRoute } from "./route.ts";
import { builtinRoutes, entryRoute, RESERVED_IDS, resolveCommand } from "./sources.ts";

export interface RouteInput {
	/** The session's enabled, installed runners (`connectedRunners`). */
	states: readonly RunnerState[];
	cwd: string;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Whether the project's settings may add entries; the host's folder trust by default. */
	projectTrusted?: boolean;
	guard?: GuardOptions;
}

export interface ExternalRoutes {
	routes: CliModelRoute[];
	/** Entries left out, with the reason: a reserved or repeated id. */
	skipped: string[];
}

const CHANGED = "this project's entry changed since you approved it: approve it again in /security, then reload.";
const WAITING = "this project's entry is off until you approve it in /security, then reload.";

/**
 * Every external CLI route of the session, in order: the built-in CLIs, then the global file's `externalModels`, then a
 * trusted project's. A project entry is a guard item of kind `agent`: always enforced, so it stays unavailable until the
 * user approves its exact launch. A repeated or reserved id is skipped (the first wins).
 */
export function externalRoutes(input: RouteInput): ExternalRoutes {
	const agentDir = input.agentDir ?? getAgentDir();
	const env = input.env ?? process.env;
	// Trust lives in the agent database, which a folder trust check creates: ask only when the project has settings to admit.
	const trusted =
		input.projectTrusted ??
		(fs.existsSync(path.join(input.cwd, CONFIG_DIR_NAME, "settings.json")) && hostTrust().folderTrusted(input.cwd));
	const settings = SettingsManager.create(input.cwd, agentDir, { projectTrusted: trusted });
	const global: ExternalModelEntry[] = settings.getGlobalSettings().externalModels ?? [];
	const project: ExternalModelEntry[] = trusted ? (settings.getProjectSettings().externalModels ?? []) : [];
	const routes = builtinRoutes(input.states, env);
	const taken = new Set<string>(RESERVED_IDS);
	const skipped: string[] = [];
	const keep = (entry: ExternalModelEntry, from: string) => {
		if (!taken.has(entry.id)) return taken.add(entry.id);
		skipped.push(`${entry.id} (${from}): the id is taken by a built-in CLI or an earlier entry.`);
		return false;
	};
	for (const entry of global)
		if (keep(entry, "settings.json")) routes.push(entryRoute(entry, "global", { cwd: input.cwd, env }));
	const own = project.filter((entry) => keep(entry, "project settings.json"));
	if (own.length) {
		const file = path.join(input.cwd, CONFIG_DIR_NAME, "settings.json");
		const scope = scopeFor(file, input.cwd);
		const inputs = own.map((entry): AgentItemInput => {
			const executable = resolveCommand(entry.command, input.cwd, env);
			return {
				id: entry.id,
				kind: entry.kind,
				command: entry.command,
				args: entry.args ?? [],
				env: entry.env ?? [],
				source: file,
				scope,
				cwd: input.cwd,
				...(executable ? { executable } : {}),
			};
		});
		const items = inputs.map(agentItem);
		const result = gate("agent", items, { ...input.guard, enforce: true });
		recordGate("agent", result, true);
		// A store fault lets guard items load unchecked elsewhere; a project's program never starts unapproved.
		const approved = new Set(
			result.reviews.filter((review) => review.word === "approved").map((review) => review.item.id),
		);
		own.forEach((entry, index) => {
			const withheld = approved.has(items[index].id) ? undefined : WAITING;
			// The approval covered the project files as they are now; each start checks they still are.
			const pinned = withheld ? undefined : agentPinHash(inputs[index]);
			const recheck =
				pinned === undefined ? undefined : () => (agentPinHash(inputs[index]) === pinned ? undefined : CHANGED);
			routes.push(
				entryRoute(entry, "project", {
					cwd: input.cwd,
					env,
					...(withheld ? { withheld } : {}),
					...(recheck ? { recheck } : {}),
				}),
			);
		});
	}
	return { routes, skipped };
}

const registered = (api: FeatureSetup, route: CliModelRoute) => {
	const signedOut = route.source === "built-in" ? () => forgetRunner(route.vendor) : undefined;
	const backend = createRouteBackend(signedOut ? { ...route, signedOut } : route);
	attachBackend(api, backend);
	return backend;
};

/**
 * Registers every external CLI route but Claude Code (its own domain, registered first by the composer) as a provider
 * bound to the session: the other built-ins and the global file's entries at setup, which has no session folder yet,
 * then the project's entries when the session starts, read from the session's own folder. Read once; a settings change
 * applies after a reload.
 */
export function registerCliModels(api: FeatureSetup, states: readonly RunnerState[]): void {
	const first = externalRoutes({ states, cwd: process.cwd(), projectTrusted: false });
	const attached = new Set<string>();
	for (const route of first.routes) {
		registered(api, route);
		attached.add(route.provider);
	}
	const warned = new Set<string>();
	const warn = (ctx: { ui: { notify(message: string, type: "warning"): void } }, lines: readonly string[]) => {
		for (const line of lines)
			if (!warned.has(line)) {
				warned.add(line);
				ctx.ui.notify(`externalModels entry skipped: ${line}`, "warning");
			}
	};
	api.bus.on("session_start", async (_event, ctx) => {
		const { routes, skipped } = externalRoutes({ states, cwd: ctx.cwd });
		for (const route of routes) {
			if (attached.has(route.provider)) continue;
			attached.add(route.provider);
			await registered(api, route).bind(ctx.sessionManager.getSessionId(), ctx.cwd);
		}
		warn(ctx, [...first.skipped, ...skipped]);
	});
}

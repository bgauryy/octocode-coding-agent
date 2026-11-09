import { builtinEffect, SWITCHABLE_BUILTIN_IDS } from "../../core/features/builtin-ids.ts";
import { homedir } from "node:os";
import { getOctocodeSkillsDir } from "../../config.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { ResourceSettings } from "../../core/package-manager/resource-settings.ts";
import { buildGroups, type ResourceItem, type ResourceType } from "../../core/package-manager/resource-groups.ts";
import { coreSkillItems } from "../../core/extensibility/core-skill-items.ts";
import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { blockedReason, switchItem } from "../../core/extensibility/switch.ts";
import { applied, closestIds, kindOf, nameOf, refused } from "../result.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry, ConfigOp, ConfigResult } from "../types.ts";

const KIND_OF_TYPE: Record<ResourceType, string> = {
	skills: "skill",
	extensions: "extension",
	prompts: "prompt",
	themes: "theme",
};

/** A path with the home folder written `~`, the form `/harness` shows. */
const tildePath = (path: string): string => {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** What loads a resource for one run only. */
const RUN_ONLY_FLAG: Record<ResourceType, string> = {
	skills: "--skill",
	prompts: "--prompt-template",
	themes: "--theme",
	extensions: "a command-line extension path",
};

interface Row {
	id: string;
	item: ResourceItem;
	/** A core skill: switched by `switchItem` (global skills pattern), not by the package settings. */
	core?: InventoryItem;
}

/** Every resource the loaders resolve, the Octocode skill collection included. `skip`: listing never installs a missing package. */
async function resourceRows(ctx: ConfigContext): Promise<Row[]> {
	const resolved = await new DefaultPackageManager({
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		settingsManager: ctx.settings,
		builtinSkillsDir: getOctocodeSkillsDir(),
		builtinExtensions: [...SWITCHABLE_BUILTIN_IDS],
	}).resolve(async () => "skip");
	const items = buildGroups(resolved, ctx.agentDir).flatMap((group) =>
		group.subgroups.flatMap((subgroup) => subgroup.items),
	);
	const counts = new Map<string, number>();
	for (const item of items) {
		const key = `${KIND_OF_TYPE[item.resourceType]}:${item.displayName}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	// A name two resources share is told apart by its path.
	const rows = items.map((item) => {
		const named = `${KIND_OF_TYPE[item.resourceType]}:${item.displayName}`;
		return { item, id: counts.get(named)! > 1 ? `${KIND_OF_TYPE[item.resourceType]}:${tildePath(item.path)}` : named };
	});
	// The skills that ship with Octocode are in no package: their rows come from the same source `/harness` lists.
	const known = new Set(rows.map((row) => row.id));
	for (const core of coreSkillItems(ctx.settings))
		if (core.resource && !known.has(core.id)) rows.push({ id: core.id, item: core.resource, core } as Row);
	return rows;
}

function toEntry(row: Row): ConfigEntry {
	const { item } = row;
	const scope = item.metadata.scope === "project" ? "project" : "global";
	return {
		id: row.id,
		kind: KIND_OF_TYPE[item.resourceType],
		label: item.displayName,
		valueType: { type: "toggle" },
		value: item.enabled,
		// The loaders resolve one winner: the scope of the file that supplies the resource.
		scopes: { [scope]: item.enabled },
		setBy: item.metadata.scope === "temporary" ? "run" : scope,
		appliesWhen: "reload",
		detail: tildePath(item.path),
	};
}

function find(rows: readonly Row[], id: string): Row | undefined {
	return (
		rows.find((row) => row.id === id) ??
		rows.find((row) => `${KIND_OF_TYPE[row.item.resourceType]}:${tildePath(row.item.path)}` === id)
	);
}

async function write(op: ConfigOp, ctx: ConfigContext, row: Row): Promise<ConfigResult> {
	const { item } = row;
	const scope = op.scope === "project" ? "project" : "global";
	const own = item.metadata.scope === (scope === "project" ? "project" : "user");
	const where = scope === "project" ? "this project" : "globally";
	if (item.metadata.scope === "temporary")
		return refused(
			op,
			`${row.id} is loaded for this run only (${RUN_ONLY_FLAG[item.resourceType]}); it has no settings entry to switch. Leave the flag out to drop it.`,
		);
	if (row.core) {
		if (op.verb === "unset") return refused(op, "A core skill has no project override to unset.");
		const on = op.verb === "enable";
		const blocked = blockedReason(row.core, scope);
		if (blocked) return refused(op, `${row.id}: ${blocked}`);
		const message = switchItem(row.core, on, scope, ctx.settings, { cwd: ctx.cwd, agentDir: ctx.agentDir });
		await ctx.settings.flush();
		return applied(op, "reload", message);
	}
	if (scope === "global" && item.metadata.scope === "project")
		return refused(op, `${row.id} comes from this project: switch it for this project.`);
	// No inherited-group map is needed: a user item is inherited by its own scope.
	const settings = new ResourceSettings(ctx.settings, ctx.cwd, ctx.agentDir, []);
	if (op.verb === "unset") {
		if (scope !== "project")
			return refused(op, "Only a project override can be unset: it goes back to inheriting the global switch.");
		settings.setProjectResourceOverride(item, "inherit");
		await ctx.settings.flush();
		return applied(op, "reload", `${row.id} follows the global switch again in this project.`);
	}
	const on = op.verb === "enable";
	if (own && item.metadata.origin === "package") settings.togglePackageResource(item, on);
	else if (own) settings.toggleTopLevelResource(item, on);
	else settings.setProjectResourceOverride(item, on ? "load" : "unload");
	await ctx.settings.flush();
	// The manager does not say when it ignores a write: read the resource back and refuse when it did not change.
	const after = find(await resourceRows(ctx), row.id);
	if (after && after.item.enabled !== on)
		return refused(
			op,
			`${row.id} is still switched ${after.item.enabled ? "on" : "off"}: the ${scope} settings did not take the change.`,
		);
	const effect = on ? undefined : builtinEffect(item.path);
	return applied(
		op,
		"reload",
		`${row.id} switched ${on ? "on" : "off"} ${where}.${effect ? ` Switching it off ${effect}.` : ""}`,
	);
}

/** Skills, extensions, prompts and themes: the `+`/`-` patterns of their settings arrays, written by `ResourceSettings`. */
export const resourcesAdapter: ConfigAdapter = {
	kinds: ["skill", "extension", "prompt", "theme"],
	async list(ctx) {
		return (await resourceRows(ctx)).map(toEntry);
	},
	async apply(op, ctx) {
		if (!["enable", "disable", "unset"].includes(op.verb))
			return refused(op, `${op.id} takes enable, disable and unset, not "${op.verb}".`);
		if (op.scope === "run")
			return refused(op, "Resources switch by editing a settings array; they have no per-run form here.");
		const rows = await resourceRows(ctx);
		const row = find(rows, op.id);
		if (!row || KIND_OF_TYPE[row.item.resourceType] !== kindOf(op.id))
			return refused(
				op,
				`No ${kindOf(op.id)} named "${nameOf(op.id)}".`,
				closestIds(
					op.id,
					rows.map((candidate) => candidate.id),
				),
			);
		try {
			return await write(op, ctx, row);
		} catch (error) {
			return refused(op, error instanceof Error ? error.message : String(error));
		}
	},
};

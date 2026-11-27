import { getOctocodeSkillsDir } from "../../config.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { ResourceSettings } from "../../core/package-manager/resource-settings.ts";
import { buildGroups, type ResourceItem, type ResourceType } from "../../core/package-manager/resource-groups.ts";
import { coreSkillItems } from "../../core/extensibility/core-skill-items.ts";
import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { blockedReason, switchItem } from "../../core/extensibility/switch.ts";
import { applied, closestIds, kindOf, nameOf, refused } from "../result.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry, ConfigOp, ConfigResult } from "../types.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import path from "node:path";
import { skillPathPrecedence } from "../../core/resource-loader/skill-precedence.ts";
import { chooseSkillWinner } from "../../core/skills.ts";

const KIND_OF_TYPE: Record<ResourceType, string> = {
	skills: "skill",
	prompts: "prompt",
	themes: "theme",
};

/** What loads a resource for one run only. */
const RUN_ONLY_FLAG: Record<ResourceType, string> = {
	skills: "--skill",
	prompts: "--prompt-template",
	themes: "--theme",
};

interface Row {
	id: string;
	item: ResourceItem;
	/** A core skill: switched by `switchItem` (global skills pattern), not by the package settings. */
	core?: InventoryItem;
	/** A switched-on skill the session does not load: the row that owns its name loads instead. */
	shadowedBy?: Row;
}

/** Every resource the loaders resolve, the Octocode skill collection included. `skip`: listing never installs a missing package. */
async function resourceRows(ctx: ConfigContext): Promise<Row[]> {
	const resolved = await new DefaultPackageManager({
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		settingsManager: ctx.settings,
		builtinSkillsDir: getOctocodeSkillsDir(),
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
	const rows: Row[] = items.map((item) => {
		const named = `${KIND_OF_TYPE[item.resourceType]}:${item.displayName}`;
		return { item, id: counts.get(named)! > 1 ? `${KIND_OF_TYPE[item.resourceType]}:${homeTilde(item.path)}` : named };
	});
	// The skills that ship with Octocode are in no package: their rows come from the same source `/harness` lists.
	for (const core of coreSkillItems(ctx.settings)) {
		if (!core.resource) continue;
		const row: Row = { id: core.id, item: core.resource, core };
		const named = rows.filter((other) => other.item.resourceType === "skills" && other.item.displayName === core.name);
		if (named.length > 0) shadowing(row, named, ctx.agentDir);
		rows.push(row);
	}
	return rows;
}

/**
 * A core skill and the package skills that share its name (the Octocode collection ships a copy of some). The session
 * loads one of them (`chooseSkillWinner`, the loader's rule: a deliberate copy beats the bundled collection, and the core
 * skill is deliberate): that row owns `skill:<name>`, so `disable skill:<name>` switches what loads, and every other
 * switched-on copy is marked shadowed under its path id. The rows are updated in place.
 */
function shadowing(core: Row, named: Row[], agentDir: string): void {
	const rank = (row: Row) =>
		skillPathPrecedence(row.item.path, {
			metadataByPath: new Map([[path.resolve(row.item.path), row.item.metadata]]),
			featurePaths: new Set(),
			agentDir,
		});
	const pathId = (row: Row) => `${KIND_OF_TYPE[row.item.resourceType]}:${homeTilde(row.item.path)}`;
	// Package skills load before the core folder, which the session adds through `resources_discover`.
	const all = [...named, core];
	const on = all.filter((row) => row.item.enabled).map((row) => ({ row, rank: rank(row) }));
	const winner = on.length > 0 ? chooseSkillWinner(on).row : core;
	for (const row of all) {
		row.id = row === winner ? core.id : pathId(row);
		if (row !== winner && row.item.enabled) row.shadowedBy = winner;
	}
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
		detail: row.shadowedBy
			? `shadowed: ${row.shadowedBy.id} loads instead · ${homeTilde(item.path)}`
			: homeTilde(item.path),
	};
}

function find(rows: readonly Row[], id: string): Row | undefined {
	return (
		rows.find((row) => row.id === id) ??
		rows.find((row) => `${KIND_OF_TYPE[row.item.resourceType]}:${homeTilde(row.item.path)}` === id)
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
	return applied(op, "reload", `${row.id} switched ${on ? "on" : "off"} ${where}.`);
}

/** Skills, prompts and themes: the `+`/`-` patterns of their settings arrays, written by `ResourceSettings`. */
export const resourcesAdapter: ConfigAdapter = {
	kinds: ["skill", "prompt", "theme"],
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

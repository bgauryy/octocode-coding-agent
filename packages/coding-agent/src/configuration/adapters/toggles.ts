import { CLAUDE_MEMORY_TOGGLE_ID } from "../../core/discovery/vendors/index.ts";
import { buildInventory } from "../../octocode/harness/inventory.ts";
import type { Inventory, InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { switchItem, vendorSwitchTarget } from "../../core/extensibility/switch.ts";
import { applied, closestIds, kindOf, refused } from "../result.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry, ConfigOp, ConfigResult } from "../types.ts";

const KINDS = ["harness", "plugin", "hook", "hooks", "installed"] as const;

/** The inventory `/harness` shows, from the same loaders; nothing is installed or executed. */
function loadInventory(ctx: ConfigContext): Promise<Inventory> {
	return buildInventory({
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		settings: ctx.settings.getSettings(),
		manager: ctx.settings,
		projectTrusted: ctx.projectTrusted,
		...(ctx.home ? { home: ctx.home } : {}),
	});
}

const toggleKeyOf = (id: string) => id;

function toEntry(item: InventoryItem, ctx: ConfigContext): ConfigEntry {
	const key = toggleKeyOf(item.id);
	const global = ctx.settings.getGlobalSettings().toggles?.[key];
	const project = ctx.projectTrusted ? ctx.settings.getProjectSettings().toggles?.[key] : undefined;
	return {
		id: item.id,
		kind: kindOf(item.id),
		label: item.label,
		valueType: { type: "toggle" },
		value: item.on,
		scopes: { ...(global === undefined ? {} : { global }), ...(project === undefined ? {} : { project }) },
		setBy: project !== undefined ? "project" : global !== undefined ? "global" : "default",
		appliesWhen: "reload",
		...(item.locked ? { locked: item.locked } : {}),
		...(item.detail ? { detail: item.detail } : {}),
	};
}

/** What `/harness` does for a harness row: the vendor key through `switchItem`, or Claude's global-only memory key. */
function switchHarness(item: InventoryItem, on: boolean, scope: "global" | "project", ctx: ConfigContext): string {
	if (item.id === CLAUDE_MEMORY_TOGGLE_ID) {
		if (scope === "project") throw new Error("Claude Code auto memory is switched globally: run it without --project.");
		ctx.settings.setToggle("global", CLAUDE_MEMORY_TOGGLE_ID, on ? true : undefined);
		return `Claude Code auto memory switched ${on ? "on" : "off"} globally.`;
	}
	const target = vendorSwitchTarget(item.name ?? "");
	if (!target) throw new Error(`${item.label} has no switch.`);
	return switchItem(target, on, scope, ctx.settings, { cwd: ctx.cwd, agentDir: ctx.agentDir });
}

async function enableDisable(op: ConfigOp, ctx: ConfigContext): Promise<ConfigResult> {
	const scope = op.scope ?? "global";
	const inventory = await loadInventory(ctx);
	const item = inventory.items.find((candidate) => candidate.id === op.id);
	const stale = inventory.stale.includes(op.id);
	if (!item && !stale)
		return refused(
			op,
			`Nothing is switchable as "${op.id}".`,
			closestIds(
				op.id,
				inventory.items.map((candidate) => candidate.id).filter((id) => KINDS.includes(kindOf(id) as never)),
			),
		);
	const on = op.verb === "enable";
	if (scope === "run") {
		// The file path's checks hold for a run too: a locked row and a gate hook stay on.
		if (item?.locked) return refused(op, `${item.label}: ${item.locked}`);
		if (item?.gate && !on)
			return refused(
				op,
				`${item.label} is a gate hook that denies when it fails; it cannot be switched off for one run.`,
			);
		ctx.settings.applyOverrides({ toggles: { [toggleKeyOf(op.id)]: on } }, { durable: true });
		return applied(op, "next-session", `${op.id} switched ${on ? "on" : "off"} for this run only.`);
	}
	try {
		const message = item
			? item.kind === "harness"
				? switchHarness(item, on, scope, ctx)
				: switchItem(item, on, scope, ctx.settings, {
						cwd: ctx.cwd,
						agentDir: ctx.agentDir,
						...(op.verb === "disable" && op.force ? { force: true } : {}),
					})
			: (ctx.settings.setToggle(scope, op.id, undefined), `Removed the stale switch ${op.id}.`);
		await ctx.settings.flush();
		return applied(op, "reload", message);
	} catch (error) {
		return refused(op, error instanceof Error ? error.message : String(error));
	}
}

/** Harnesses, plugins and hooks: one `toggles` key per item, written by `switchItem` as `/harness` does. */
export const togglesAdapter: ConfigAdapter = {
	kinds: KINDS,
	async list(ctx) {
		const inventory = await loadInventory(ctx);
		return inventory.items.filter((item) => KINDS.includes(kindOf(item.id) as never)).map((item) => toEntry(item, ctx));
	},
	async apply(op, ctx) {
		switch (op.verb) {
			case "enable":
			case "disable":
				return enableDisable(op, ctx);
			case "unset": {
				if (op.scope === "run") return refused(op, "A per-run switch cannot be unset: it lasts only this process.");
				ctx.settings.setToggle(op.scope ?? "global", op.id, undefined);
				await ctx.settings.flush();
				return applied(
					op,
					"reload",
					`${op.id}: the ${op.scope ?? "global"} switch is removed; the broader switches decide again.`,
				);
			}
			default:
				return refused(op, `${op.id} takes enable, disable and unset, not "${op.verb}".`);
		}
	},
};

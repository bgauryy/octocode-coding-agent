import { buildInventory } from "../../octocode/harness/inventory.ts";
import { withReviewState } from "../../octocode/harness/review-state.ts";
import type { Inventory, InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { switchItem } from "../../core/extensibility/switch.ts";
import { switchHarness, switchOnPreview } from "../../octocode/harness/vendor-items.ts";
import { applied, closestIds, kindOf, refused } from "../result.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry, ConfigOp, ConfigResult } from "../types.ts";

const KINDS = ["harness", "plugin", "hook", "hooks", "installed"] as const;

/** The inventory `/harness` shows, from the same loaders; nothing is installed or executed. */
async function loadInventory(ctx: ConfigContext): Promise<Inventory> {
	const inventory = await buildInventory({
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		settings: ctx.settings.getSettings(),
		manager: ctx.settings,
		projectTrusted: ctx.projectTrusted,
		...(ctx.home ? { home: ctx.home } : {}),
	});
	// The security review's badge leads each reviewed row's detail, as on /security.
	return { ...inventory, items: withReviewState(inventory.items) };
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

/**
 * What switching a harness on brings, each item scanned now (static; nothing runs), as the lines printed before the switch.
 * Switching off prints nothing. Items stay off until approved in `/security`.
 */
function onPreview(item: InventoryItem, on: boolean, ctx: ConfigContext): string[] {
	if (!on || item.kind !== "harness") return [];
	return (
		switchOnPreview(item, {
			cwd: ctx.cwd,
			agentDir: ctx.agentDir,
			projectTrusted: ctx.projectTrusted,
			settings: ctx.settings.getSettings(),
			...(ctx.home ? { home: ctx.home } : {}),
		}) ?? []
	);
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
		const preview = item ? onPreview(item, on, ctx) : [];
		ctx.settings.applyOverrides({ toggles: { [toggleKeyOf(op.id)]: on } }, { durable: true });
		return applied(
			op,
			"next-session",
			[...preview, `${op.id} switched ${on ? "on" : "off"} for this run only.`].join("\n"),
		);
	}
	try {
		const preview = item ? onPreview(item, on, ctx) : [];
		const message = item
			? item.kind === "harness"
				? [...preview, switchHarness(item, on, scope, ctx.settings, { cwd: ctx.cwd, agentDir: ctx.agentDir })].join(
						"\n",
					)
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

import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { buildInventory, type InventoryItem, renderInventory } from "../../core/extensibility/inventory.ts";
import { type SwitchScope, switchItem } from "../../core/extensibility/switch.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { registerHooksCommand } from "../hooks/register.ts";
import type { HooksView } from "../hooks/register/types.ts";
import { type Subcommand, type Subcommands, say } from "../shared/commands.ts";
import { tildePath } from "../shared/home.ts";
import { PluginsPicker } from "./picker.ts";

const USAGE = "Usage: /plugins [list] | /plugins enable|disable <id> [--local] [--force]";

/** File-backed settings (scoped reads, locked writes) beside the session's merged view. */
async function load(api: ExtensionAPI, ctx: ExtensionCommandContext) {
	const agentDir = getAgentDir();
	const manager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
	const inventory = await buildInventory({
		cwd: ctx.cwd,
		agentDir,
		settings: api.getSettings(),
		manager,
		projectTrusted: ctx.isProjectTrusted(),
	});
	return { agentDir, manager, inventory };
}

/** `/plugins`: every plugin, extension and hook per host, with a switch for each. */
export function pluginsCommand(api: ExtensionAPI): Subcommand {
	return {
		description: "List and switch plugins, extensions and hooks",
		dialog: "interaction",
		complete: (prefix) =>
			["list", "enable", "disable"]
				.filter((word) => word.startsWith(prefix))
				.map((word) => ({ value: word, label: word })),
		handler: async (args, ctx) => {
			const [action = "", id, ...flags] = args.split(/\s+/).filter(Boolean);
			const { agentDir, manager, inventory } = await load(api, ctx);
			const apply = (item: InventoryItem, on: boolean, scope: SwitchScope, force: boolean) =>
				switchItem(item, on, scope, manager, { cwd: ctx.cwd, agentDir, force });
			if (action === "enable" || action === "disable") {
				if (!id) return say(ctx, `${USAGE}\nRun /plugins for the IDs.`, "warning");
				const unknownFlags = flags.filter((flag) => flag !== "--local" && flag !== "--force");
				if (unknownFlags.length) return say(ctx, `${USAGE}\nUnknown option ${unknownFlags.join(" ")}.`, "warning");
				const item = inventory.items.find((candidate) => candidate.id === id);
				const stale = inventory.stale.includes(id);
				if (!item && !stale) return say(ctx, `Unknown id ${id}; run /plugins for the list.`, "warning");
				try {
					const scope: SwitchScope = flags.includes("--local") ? "project" : "global";
					if (stale) manager.setToggle(scope, id, undefined);
					const message = stale
						? `Removed the stale switch ${id}.`
						: apply(item!, action === "enable", scope, flags.includes("--force"));
					await manager.flush();
					say(ctx, `${message} Run /reload to apply.`);
				} catch (error) {
					say(ctx, errorMessage(error), "warning");
				}
				return;
			}
			if (action && action !== "list") return say(ctx, USAGE, "warning");
			if (action === "list" || ctx.mode !== "tui" || !ctx.hasUI) return say(ctx, renderInventory(inventory));
			const changed = await ctx.ui.custom<boolean>(
				(tui, theme, keybindings, done) =>
					new PluginsPicker(
						{
							items: inventory.items,
							apply,
							projectTrusted: ctx.isProjectTrusted(),
							paths: {
								global: tildePath(path.join(agentDir, "settings.json")),
								project: path.join(CONFIG_DIR_NAME, "settings.json"),
							},
							height: process.stdout.rows ?? 24,
							summary: [
								inventory.stale.length &&
									`${inventory.stale.length} stale switch${inventory.stale.length === 1 ? "" : "es"}`,
								inventory.ignored.length &&
									`${inventory.ignored.length} ignored project switch${inventory.ignored.length === 1 ? "" : "es"}`,
								inventory.notes.length &&
									`${inventory.notes.length} diagnostic${inventory.notes.length === 1 ? "" : "s"}`,
							]
								.filter(Boolean)
								.join(" · "),
							done,
							requestRender: () => tui.requestRender(),
						},
						theme,
						keybindings,
					),
			);
			await manager.flush();
			if (!changed) return;
			if (
				await ctx.ui.confirm(
					"Apply the changes?",
					"Reload now so the switched plugins, extensions and hooks take effect.",
				)
			)
				await ctx.reload();
			else say(ctx, "Switches saved. Run /reload to apply them.");
		},
	};
}

/** `/hooks` (what loaded and from where) and `/plugins` (switch plugins, extensions and hooks). */
export function registerExtensibilityCommands(commands: Subcommands, hooks: HooksView, api: ExtensionAPI): void {
	registerHooksCommand(commands, hooks);
	commands.add("plugins", pluginsCommand(api));
}

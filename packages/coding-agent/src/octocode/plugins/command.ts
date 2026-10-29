import { truncateToWidth } from "@octocodeai/octocode-tui";
import { getAgentDir } from "../../config.ts";
import {
	buildInventory,
	HOST_TITLES,
	type InventoryItem,
	renderInventory,
} from "../../core/extensibility/inventory.ts";
import { type SwitchScope, switchItem } from "../../core/extensibility/switch.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { errorMessage } from "../../utils/guards.ts";
import { registerHooksCommand } from "../hooks/register.ts";
import type { HooksView } from "../hooks/register/types.ts";
import { type Subcommand, type Subcommands, say } from "../shared/commands.ts";
import { sanitizeTerminalText } from "../shared/sanitize.ts";

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

/** The terminal list: ↑↓ move, Space switch, Tab scope, r reload and close, Esc close. */
function showPicker(
	ctx: ExtensionCommandContext,
	items: InventoryItem[],
	apply: (item: InventoryItem, on: boolean, scope: SwitchScope, force: boolean) => string,
): Promise<"reload" | "changed" | "unchanged"> {
	return ctx.ui.custom<"reload" | "changed" | "unchanged">((tui, theme, keybindings, done) => {
		let cursor = 0;
		let scope: SwitchScope = "global";
		let changed = false;
		let flash: string | undefined;
		let confirmGate: string | undefined;
		const refresh = () => tui.requestRender();
		function toggle(item: InventoryItem) {
			const on = !item.on;
			const force = confirmGate === item.id;
			if (!on && item.gate && !force) {
				confirmGate = item.id;
				flash = `${item.label} denies when it fails. Press Space again to switch it off.`;
				return;
			}
			confirmGate = undefined;
			try {
				flash = apply(item, on, scope, force);
				item.on = on;
				changed = true;
			} catch (error) {
				flash = errorMessage(error);
			}
		}
		return {
			handleInput(data: string) {
				const item = items[cursor];
				if (keybindings.matches(data, "tui.select.cancel")) return done(changed ? "changed" : "unchanged");
				if (data === "r") return done("reload");
				if (keybindings.matches(data, "tui.select.up")) cursor = (cursor + items.length - 1) % items.length;
				else if (keybindings.matches(data, "tui.select.down")) cursor = (cursor + 1) % items.length;
				else if (data === "\t") {
					scope = scope === "global" ? "project" : "global";
					flash = scope === "project" && !ctx.isProjectTrusted() ? "Trust this project first (/trust)." : undefined;
				} else if (data === " " && item) toggle(item);
				refresh();
			},
			render(width: number): string[] {
				const lines: string[] = [];
				const push = (text: string) => lines.push(truncateToWidth(text, Math.max(20, width), "…"));
				push(theme.fg("accent", "─".repeat(Math.max(20, width))));
				push(
					` ${theme.bold("Plugins, extensions and hooks")}  ${theme.fg("muted", `Scope: ${scope === "global" ? "[Global]  Project" : "Global  [Project]"}`)}`,
				);
				let host: string | undefined;
				items.forEach((item, index) => {
					if (item.host !== host) {
						host = item.host;
						push(` ${theme.fg("accent", theme.bold(HOST_TITLES[item.host]))}`);
					}
					const box = item.locked ? "[-]" : item.on ? "[x]" : "[ ]";
					const text = `${"  ".repeat(item.depth)}${box} ${sanitizeTerminalText(item.label)}${item.detail ? theme.fg("dim", ` — ${sanitizeTerminalText(item.detail)}`) : ""}`;
					push(index === cursor ? `${theme.fg("accent", " › ")}${text}` : `   ${text}`);
				});
				if (!items.length) push(theme.fg("dim", "   Nothing configured."));
				if (flash) push(` ${theme.fg("warning", sanitizeTerminalText(flash))}`);
				push(
					theme.fg(
						"dim",
						` Space switch · Tab scope · r reload and close · Esc close${changed ? " (changes apply after /reload)" : ""}`,
					),
				);
				push(theme.fg("accent", "─".repeat(Math.max(20, width))));
				return lines;
			},
			invalidate() {},
		};
	});
}

/** `/plugins`: every plugin, extension and hook per host, with a switch for each. */
export function pluginsCommand(api: ExtensionAPI): Subcommand {
	return {
		description: "plugins [enable|disable <id>] — list and switch plugins, extensions and hooks per host",
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
				const item = inventory.items.find((candidate) => candidate.id === id);
				const stale = id !== undefined && inventory.stale.includes(id);
				if (!id || (!item && !stale))
					return say(ctx, `${USAGE}\nUnknown id ${id ?? ""}; run /plugins for the list.`, "warning");
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
			const result = await showPicker(ctx, inventory.items, apply);
			await manager.flush();
			if (result === "reload") await ctx.reload();
			else if (result === "changed") say(ctx, "Switches saved. Run /reload to apply them.");
		},
	};
}

/** `/hooks` (what loaded and from where) and `/plugins` (switch plugins, extensions and hooks). */
export function registerExtensibilityCommands(commands: Subcommands, hooks: HooksView, api: ExtensionAPI): void {
	registerHooksCommand(commands, hooks);
	commands.add("plugins", pluginsCommand(api));
}

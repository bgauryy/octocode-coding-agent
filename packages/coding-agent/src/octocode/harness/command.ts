import path from "node:path";
import type { AutocompleteItem } from "@octocodeai/octocode-tui";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getMcpSessionStatus } from "../../../../mcp/src/status.ts";
import { getMcpSwitch, requestMcpReload } from "../../../../mcp/src/switch.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import {
	buildInventory,
	type Inventory,
	type InventoryItem,
	renderInventory,
} from "../../core/extensibility/inventory.ts";
import { type SwitchScope, switchItem } from "../../core/extensibility/switch.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/features/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { showLoadedConfig } from "../discovery/config-command.ts";
import { hookEventsReport } from "../hooks/register/report.ts";
import type { HooksView } from "../hooks/register/types.ts";
import { runPluginCommand } from "../plugins/marketplace/command.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { tildePath } from "../shared/home.ts";
import { HarnessPicker } from "./picker.ts";
import { switchHarness } from "./vendor-items.ts";

/** `/harness list <section>` filters: each names the rows it keeps. */
const SECTIONS: Record<string, (item: InventoryItem) => boolean> = {
	plugins: (item) => item.kind === "plugin",
	hooks: (item) => item.kind === "hooks" || item.kind === "hook-file" || item.kind === "hook",
	skills: (item) => item.kind === "skill",
	mcp: (item) => item.kind === "mcp",
	extensions: (item) => item.kind === "extension",
};
const MARKETPLACE_ACTIONS = ["install", "update", "remove"];
const SUBCOMMANDS: Array<[string, string]> = [
	["list", "Print the inventory, or one section"],
	["enable", "Switch items or a harness on (claude, codex, cursor, pi, agents, mcp-json)"],
	["disable", "Switch items or a harness off"],
	["install", "Install a marketplace plugin"],
	["update", "Update a marketplace plugin"],
	["remove", "Remove a marketplace plugin"],
	["hooks", "Loaded hooks, timing and diagnostics"],
	["config", "Loaded config and where it came from"],
];
const USAGE = [
	"Usage: /harness opens the switch list (text outside the terminal)",
	`  /harness list [${Object.keys(SECTIONS).join("|")}|<text>]`,
	"  /harness enable|disable <id|name|harness>... [--project] [--force]",
	"  /harness install|update|remove <plugin@marketplace> [--yes]",
	"  /harness hooks [events]",
	"  /harness config",
].join("\n");

type McpChange = { name: string; enabled: boolean; inProject: boolean };

/** The saved global and project settings, to tell whether a batch of writes changed anything a reload would apply. */
const savedSettings = (manager: SettingsManager): string =>
	JSON.stringify([manager.getGlobalSettings(), manager.getProjectSettings()]);

const where = (scope: SwitchScope) => (scope === "project" ? "for this project" : "globally");

/**
 * After a harness switch is saved, the MCP owner re-reads its files and connects or drops the difference at once (a
 * harness's servers need no reload); one line says what changed.
 */
async function reloadMcp(api: ExtensionAPI): Promise<string> {
	let result: Awaited<ReturnType<typeof requestMcpReload>>;
	try {
		result = await requestMcpReload(api.events);
	} catch (error) {
		return `Warning: the switches are saved, but the MCP reload failed (${errorMessage(error)}); run /reload to apply them.`;
	}
	if (!result) return "MCP is off in this session, so no servers changed.";
	if (!result.added.length && !result.removed.length) return "MCP servers unchanged.";
	return [
		result.added.length ? `MCP servers added: ${result.added.join(", ")}` : "",
		result.removed.length ? `MCP servers removed: ${result.removed.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("; ");
}

type Resolved = { item: InventoryItem } | { stale: true } | { error: string };

/** The item a query names: its exact ID, else the one item with that name; a stale switch key is reported as such. */
function resolve(inventory: Inventory, query: string): Resolved {
	const byId = inventory.items.find((item) => item.id === query);
	if (byId) return { item: byId };
	if (inventory.stale.includes(query)) return { stale: true };
	const named = inventory.items.filter((item) => item.name?.toLowerCase() === query.toLowerCase());
	if (named.length === 1) return { item: named[0] };
	if (named.length > 1)
		return { error: `Several items are named ${query}; use an ID: ${named.map((item) => item.id).join(", ")}` };
	return { error: `Nothing is named ${query}; /harness list shows the IDs.` };
}

/**
 * `/harness`: one place to see and switch what extends a session: plugins, hooks, skills, MCP servers and extensions.
 * Settings-backed switches (plugins, hooks, skills, extensions) apply on `/reload`, so a batch of them costs one reload
 * and one prompt-cache rebuild; MCP switches go to the MCP owner, which opens or closes the connection at once.
 */
export function registerHarnessCommand(commands: Subcommands, hooks: HooksView, api: ExtensionAPI): void {
	// The last listing, so `enable`/`disable` completions offer real IDs and names without rebuilding the inventory.
	let known: InventoryItem[] = [];

	async function load(ctx: ExtensionCommandContext) {
		const agentDir = getAgentDir();
		const manager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
		const inventory = await buildInventory({
			cwd: ctx.cwd,
			agentDir,
			settings: api.getSettings(),
			manager,
			projectTrusted: ctx.isProjectTrusted(),
			mcp: getMcpSessionStatus(api.events),
		});
		known = inventory.items;
		return { agentDir, manager, inventory };
	}

	/**
	 * Ends a batch. Saved settings that changed cost one reload (and one prompt-cache rebuild), offered in the terminal;
	 * when it is accepted, MCP switches are only saved, because the reloaded session reads them anyway. Otherwise they
	 * apply at once. Nothing is offered when the writes left the files as they were.
	 */
	async function finish(
		ctx: ExtensionCommandContext,
		batch: { lines: string[]; failed: boolean; settingsChanged: boolean; mcpChanges: McpChange[] },
	): Promise<void> {
		const { lines, settingsChanged, mcpChanges } = batch;
		let failed = batch.failed;
		const mcp = getMcpSwitch(api.events);
		const runMcp = async (saveOnly: boolean) => {
			for (const change of mcpChanges) {
				const result = mcp
					? await mcp({ ...change, saveOnly })
					: { ok: false, message: "MCP is not running in this session." };
				failed ||= !result.ok;
				lines.push(result.message);
			}
		};
		if (settingsChanged && !failed && ctx.mode === "tui" && ctx.hasUI) {
			const queued = mcpChanges.map(
				(change) =>
					`${change.name} switches ${change.enabled ? "on" : "off"} ${where(change.inProject ? "project" : "global")}.`,
			);
			const question = [
				...lines,
				...queued,
				"Reloading applies the switches; the next request rebuilds the prompt cache once.",
			].join("\n");
			if (await ctx.ui.confirm("Reload now?", question)) {
				await runMcp(true);
				if (failed) say(ctx, lines.join("\n"), "warning");
				return ctx.reload();
			}
		}
		await runMcp(false);
		if (!lines.length) return;
		say(ctx, `${lines.join("\n")}${settingsChanged ? "\nRun /reload to apply." : ""}`, failed ? "warning" : "info");
	}

	async function switchCommand(on: boolean, words: string[], ctx: ExtensionCommandContext): Promise<void> {
		const flags = words.filter((word) => word.startsWith("--"));
		const queries = words.filter((word) => !word.startsWith("--"));
		const unknown = flags.filter((flag) => flag !== "--local" && flag !== "--project" && flag !== "--force");
		if (!queries.length || unknown.length)
			return say(ctx, `${unknown.length ? `Unknown option ${unknown.join(" ")}.\n` : ""}${USAGE}`, "warning");
		const scope: SwitchScope = flags.includes("--local") || flags.includes("--project") ? "project" : "global";
		let harnessSwitched = false;
		const { agentDir, manager, inventory } = await load(ctx);
		const before = savedSettings(manager);
		const lines: string[] = [];
		const mcpChanges: McpChange[] = [];
		let failed = false;
		for (const query of queries) {
			const resolved = resolve(inventory, query);
			try {
				if ("stale" in resolved) {
					manager.setToggle(scope, query, undefined);
					lines.push(`Removed the stale switch ${query}.`);
					continue;
				}
				if ("error" in resolved) {
					failed = true;
					lines.push(resolved.error);
					continue;
				}
				const found = resolved.item;
				// MCP switches wait for the end of the batch, so they can be saved for a reload rather than applied twice.
				if (found.kind === "mcp")
					mcpChanges.push({ name: found.name ?? found.label, enabled: on, inProject: scope === "project" });
				else if (found.kind === "harness") {
					lines.push(switchHarness(found, on, scope, manager, { cwd: ctx.cwd, agentDir }));
					harnessSwitched = true;
				}
				// Rows show the loaded session, which a switch saved before the last reload may differ from, so the switch
				// is always written; comparing the saved files afterwards decides whether a reload is needed.
				else
					lines.push(
						switchItem(found, on, scope, manager, { cwd: ctx.cwd, agentDir, force: flags.includes("--force") }),
					);
			} catch (error) {
				failed = true;
				lines.push(errorMessage(error));
			}
		}
		await manager.flush();
		const settingsChanged = savedSettings(manager) !== before;
		if (harnessSwitched && settingsChanged) lines.push(await reloadMcp(api));
		if (!settingsChanged && lines.length && !failed)
			lines.push("The saved settings already matched; nothing to reload.");
		await finish(ctx, { lines, failed, settingsChanged, mcpChanges });
	}

	async function marketplace(words: string[], ctx: ExtensionCommandContext): Promise<void> {
		// Approval is asked in the terminal UI; without one (print, RPC) the user passes --yes.
		const lines: string[] = [];
		const code = await runPluginCommand(words, {
			cwd: ctx.cwd,
			out: (text) => void lines.push(text),
			err: (text) => void lines.push(text),
			confirm: ctx.mode === "tui" && ctx.hasUI ? (question) => ctx.ui.confirm("Plugin", question) : undefined,
		});
		say(
			ctx,
			code === 0 ? `${lines.join("\n")}\nRun /reload to apply.` : lines.join("\n"),
			code === 0 ? "info" : "warning",
		);
	}

	async function picker(ctx: ExtensionCommandContext): Promise<void> {
		const { agentDir, manager, inventory } = await load(ctx);
		const before = savedSettings(manager);
		// MCP switches wait for the list to close: a row toggled back and forth costs nothing, and each server switches once.
		const pending = new Map<string, { item: InventoryItem; on: boolean; scope: SwitchScope; was: boolean }>();
		let harnessSwitched = false;
		const apply = (item: InventoryItem, on: boolean, scope: SwitchScope, force: boolean): string => {
			if (item.kind === "harness") {
				harnessSwitched = true;
				return switchHarness(item, on, scope, manager, { cwd: ctx.cwd, agentDir });
			}
			if (item.kind !== "mcp") return switchItem(item, on, scope, manager, { cwd: ctx.cwd, agentDir, force });
			if (!getMcpSwitch(api.events)) throw new Error("MCP is not running in this session.");
			pending.set(item.id, { item, on, scope, was: pending.get(item.id)?.was ?? item.on });
			return `${item.label} switches ${on ? "on" : "off"} ${where(scope)} when this list closes.`;
		};
		const count = (n: number, noun: string) => n && `${n} ${noun}${n === 1 ? "" : "es"}`;
		await ctx.ui.custom<boolean>(
			(tui, theme, keybindings, done) =>
				new HarnessPicker(
					{
						items: inventory.items,
						apply,
						paths: {
							global: `${tildePath(path.join(agentDir, "settings.json"))} (MCP: its mcp.json)`,
							project: `${path.join(CONFIG_DIR_NAME, "settings.json")} (MCP: ${path.join(CONFIG_DIR_NAME, "mcp.json")})`,
						},
						height: process.stdout.rows ?? 24,
						summary: [
							count(inventory.stale.length, "stale switch"),
							count(inventory.ignored.length, "ignored project switch"),
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
		const settingsChanged = savedSettings(manager) !== before;
		const mcpChanges = [...pending.values()]
			.filter((change) => change.on !== change.was)
			.map((change) => ({
				name: change.item.name ?? change.item.label,
				enabled: change.on,
				inProject: change.scope === "project",
			}));
		await finish(ctx, {
			lines: settingsChanged ? ["Switches saved.", ...(harnessSwitched ? [await reloadMcp(api)] : [])] : [],
			failed: false,
			settingsChanged,
			mcpChanges,
		});
	}

	commands.add("harness", {
		description: "Switch plugins, hooks, skills, MCPs, extensions",
		argumentHint: "[list|enable|disable|install|update|remove|hooks|config]",
		dialog: "interaction",
		complete: (prefix): AutocompleteItem[] | null => {
			const match = /^(\S+)\s+(.*)$/s.exec(prefix);
			if (!match) return wordCompletions(SUBCOMMANDS, prefix);
			const [, action, rest] = match;
			const prefixWith = (items: AutocompleteItem[] | null) =>
				items?.map((item) => ({ ...item, value: `${action} ${item.value}` })) ?? null;
			if (action === "list") return prefixWith(wordCompletions(Object.keys(SECTIONS), rest));
			if (action === "hooks") return prefixWith(wordCompletions(["events"], rest));
			if (action !== "enable" && action !== "disable") return null;
			const words = rest.split(/\s+/);
			const last = words.pop() ?? "";
			const head = [action, ...words].join(" ");
			const items = known.length
				? known
				: getMcpSessionStatus(api.events).map((server) => ({
						id: `mcp:${server.name}`,
						name: server.name,
						label: server.name,
					}));
			const choices = items
				.filter((item) => !("locked" in item && item.locked))
				.map((item): [string, string] => [item.name ?? item.id, item.label]);
			return wordCompletions(choices, last)?.map((item) => ({ ...item, value: `${head} ${item.value}` })) ?? null;
		},
		handler: async (args, ctx) => {
			const [action = "", ...words] = args.split(/\s+/).filter(Boolean);
			if (action === "enable" || action === "disable") return switchCommand(action === "enable", words, ctx);
			if (MARKETPLACE_ACTIONS.includes(action)) return marketplace([action, ...words], ctx);
			if (action === "hooks") {
				if (words[0] === "events" && words.length === 1) return say(ctx, hookEventsReport());
				if (words.length)
					return say(
						ctx,
						'Usage: /harness hooks [events] (inspection only). Switch hooks with /harness enable|disable <id> (IDs: /harness list hooks); "disableAllHooks": true in a hook file turns them all off.',
						"warning",
					);
				return say(ctx, hooks.report(ctx.cwd));
			}
			if (action === "config") return words.length ? say(ctx, USAGE, "warning") : showLoadedConfig(api, ctx);
			if (action === "list") {
				const { inventory } = await load(ctx);
				const filter = words.join(" ").toLowerCase();
				if (!filter) return say(ctx, renderInventory(inventory));
				const section = SECTIONS[filter];
				const rows = inventory.items.filter((item) =>
					section
						? section(item)
						: [item.label, item.id, item.detail].some((text) => text.toLowerCase().includes(filter)),
				);
				return say(ctx, renderInventory(inventory, rows));
			}
			if (action) return say(ctx, USAGE, "warning");
			if (ctx.mode !== "tui" || !ctx.hasUI) return say(ctx, renderInventory((await load(ctx)).inventory));
			return picker(ctx);
		},
	});
}

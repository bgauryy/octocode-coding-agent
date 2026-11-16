import path from "node:path";
import type { AutocompleteItem } from "@octocodeai/octocode-tui";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getMcpSessionStatus, getMcpSwitch, requestMcpReload } from "../../../../mcp/src/api.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { createConfiguration } from "../../configuration/index.ts";
import { buildInventory, type InventoryItem, renderInventory } from "./inventory.ts";
import { withReviewState } from "./review-state.ts";
import { type SwitchScope, switchItem } from "../../core/extensibility/switch.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/features/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { showLoadedConfig } from "../discovery/config-command.ts";
import { hookEventsReport } from "../hooks/register/report.ts";
import type { HooksView } from "../hooks/register/types.ts";
import { runPluginCommand } from "../plugins/marketplace/command.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { confirmAction, successNotice } from "../shared/page.ts";
import { createMcpToolsSource } from "./mcp-tools.ts";
import { HarnessPicker } from "./picker.ts";
import { HARNESS_SECTIONS, type HarnessSection, sectionOf } from "./sections.ts";
import { switchHarness, switchOnPreview } from "./vendor-items.ts";

/** `/harness list <section>` filters: each names the rows it keeps. */
const SECTIONS: Record<string, (item: InventoryItem) => boolean> = {
	plugins: (item) => item.kind === "plugin",
	hooks: (item) => item.kind === "hooks" || item.kind === "hook-file" || item.kind === "hook",
	skills: (item) => item.kind === "skill",
	mcp: (item) => item.kind === "mcp",
	extensions: (item) => item.kind === "extension",
	sources: (item) => sectionOf(item) === "sources",
};
/** `/harness <section>` opens the picker on that section; outside the terminal it prints it. */
const PICKER_SECTIONS = Object.keys(HARNESS_SECTIONS);
const MARKETPLACE_ACTIONS = ["install", "update", "remove"];
const SUBCOMMANDS: Array<[string, string]> = [
	["overview", "Open the picker on the Overview"],
	["skills", "Open the picker on Skills"],
	["mcp", "Open the picker on MCPs"],
	["sources", "Open the picker on Sources"],
	["extensions", "Open the picker on Extensions"],
	["list", "Print the inventory, or one section"],
	["install", "Install a marketplace plugin"],
	["update", "Update a marketplace plugin"],
	["remove", "Remove a marketplace plugin"],
	["hooks", "Hooks section; `hooks events|test` inspects them"],
	["config", "Loaded config and where it came from"],
];
const USAGE = [
	"Usage: /harness opens the switch list on its Overview (text outside the terminal)",
	`  /harness <${PICKER_SECTIONS.join("|")}>  open that section`,
	`  /harness list [${Object.keys(SECTIONS).join("|")}|<text>]`,
	"  /harness install|update|remove <plugin@marketplace> [--yes]",
	"  /harness hooks [events|test <Event> [<tool or matcher> [<json>]]]",
	"  /harness config",
].join("\n");

/**
 * The retired `/harness enable|disable` as the `/configuration` line that replaces it. A word that is an id already
 * (`kind:name`) stays; a bare name resolves through the catalog when exactly one entry has that name.
 */
async function switchMoved(
	action: string,
	words: readonly string[],
	catalog: ReturnType<typeof createConfiguration>,
): Promise<string> {
	const local = words.some((word) => word === "--local" || word === "--project");
	const force = words.includes("--force");
	const ids: string[] = [];
	const unresolved: string[] = [];
	for (const word of words.filter((candidate) => !candidate.startsWith("--"))) {
		if (word.includes(":")) {
			ids.push(word);
			continue;
		}
		const named = (await catalog.list({ text: word })).filter(
			(entry) => entry.id.slice(entry.id.indexOf(":") + 1).toLowerCase() === word.toLowerCase(),
		);
		// `claude` names a harness and its hooks row alike: the harness is what a bare name meant.
		const harnesses = named.filter((entry) => entry.kind === "harness");
		const pick = named.length === 1 ? named : harnesses.length === 1 ? harnesses : [];
		if (pick.length === 1) ids.push(pick[0].id);
		else unresolved.push(word);
	}
	const flags = `${local ? " --local" : ""}${force ? " --force" : ""}`;
	const head = `/harness ${action} moved to /configuration.`;
	if (unresolved.length)
		return `${head} ${unresolved.map((word) => `"${word}"`).join(", ")} needs an id (kind:name, such as harness:claude, hook:<id>, plugin:<id>, skill:<name>, mcp:<name>): /configuration list <name> shows the ids.${ids.length ? ` Run /configuration ${action} ${ids.join(" ")}${flags} for the rest.` : ""}`;
	if (!ids.length) return `${head} Run /configuration ${action} <id>... (/configuration list shows the ids).`;
	return `${head} Run /configuration ${action} ${ids.join(" ")}${flags}.`;
}

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

/**
 * `/harness`: one place to see and switch what extends a session: plugins, hooks, skills, MCP servers and extensions.
 * Settings-backed switches (plugins, hooks, skills, extensions) apply on `/reload`, so a batch of them costs one reload
 * and one prompt-cache rebuild; MCP switches go to the MCP owner, which opens or closes the connection at once.
 */
export function registerHarnessCommand(commands: Subcommands, hooks: HooksView, api: ExtensionAPI): void {
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
		inventory.items = withReviewState(inventory.items);
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
			const select = (title: string, options: string[]) => ctx.ui.select(title, options);
			if (await confirmAction(select, `Reload now?\n${question}`, ["Reload"])) {
				await runMcp(true);
				if (failed) say(ctx, lines.join("\n"), "warning");
				return ctx.reload();
			}
		}
		await runMcp(false);
		if (!lines.length) return;
		say(ctx, `${lines.join("\n")}${settingsChanged ? "\nRun /reload to apply." : ""}`, failed ? "warning" : "info");
	}

	async function marketplace(words: string[], ctx: ExtensionCommandContext): Promise<void> {
		// Approval is asked in the terminal UI; without one (print, RPC) the user passes --yes.
		const lines: string[] = [];
		const code = await runPluginCommand(words, {
			cwd: ctx.cwd,
			out: (text) => void lines.push(text),
			err: (text) => void lines.push(text),
			confirm:
				ctx.mode === "tui" && ctx.hasUI
					? async (question) =>
							!!(await confirmAction((title, options) => ctx.ui.select(title, options), question, ["Continue"]))
					: undefined,
		});
		say(
			ctx,
			code === 0 ? `${lines.join("\n")}\nRun /reload to apply.` : lines.join("\n"),
			code === 0 ? "info" : "warning",
		);
	}

	async function picker(ctx: ExtensionCommandContext, section: HarnessSection = "overview"): Promise<void> {
		let loaded: Awaited<ReturnType<typeof load>> | undefined;
		let before = "";
		let closed = false;
		let loading = false;
		let view: HarnessPicker;
		const beginLoad = () => {
			if (loading) return;
			loading = true;
			void load(ctx)
				.then((result) => {
					if (closed) return;
					loaded = result;
					before = savedSettings(result.manager);
					const { inventory } = result;
					view.loaded(
						inventory.items,
						[
							inventory.stale.length ? `${inventory.stale.length} stale switches` : "",
							inventory.ignored.length ? `${inventory.ignored.length} ignored project switches` : "",
							inventory.notes.length ? `${inventory.notes.length} diagnostics` : "",
						]
							.filter(Boolean)
							.join(" · "),
					);
				})
				.catch((error) => {
					if (!closed) view.failed(errorMessage(error));
				})
				.finally(() => {
					loading = false;
				});
		};
		// MCP switches wait for the list to close: a row toggled back and forth costs nothing, and each server switches once.
		const pending = new Map<string, { item: InventoryItem; on: boolean; scope: SwitchScope; was: boolean }>();
		let harnessSwitched = false;
		const apply = (item: InventoryItem, on: boolean, scope: SwitchScope, force: boolean): string => {
			if (!loaded) throw new Error("Harness inventory is not ready.");
			const { manager, agentDir } = loaded;
			if (item.kind === "harness") {
				harnessSwitched = true;
				return switchHarness(item, on, scope, manager, { cwd: ctx.cwd, agentDir });
			}
			if (item.kind !== "mcp") return switchItem(item, on, scope, manager, { cwd: ctx.cwd, agentDir, force });
			if (!getMcpSwitch(api.events)) throw new Error("MCP is not running in this session.");
			pending.set(item.id, { item, on, scope, was: pending.get(item.id)?.was ?? item.on });
			return `${item.label} switches ${on ? "on" : "off"} ${where(scope)} when this list closes.`;
		};
		try {
			await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
				view = new HarnessPicker(
					{
						items: [],
						state: "loading",
						section,
						retry: beginLoad,
						apply,
						preview: (item) =>
							loaded &&
							switchOnPreview(item, {
								cwd: ctx.cwd,
								agentDir: loaded.agentDir,
								projectTrusted: ctx.isProjectTrusted(),
								settings: api.getSettings(),
							}),
						mcpTools: createMcpToolsSource({
							ctx: () => {
								if (!loaded) throw new Error("Harness inventory is not ready.");
								return {
									cwd: ctx.cwd,
									agentDir: loaded.agentDir,
									settings: loaded.manager,
									projectTrusted: ctx.isProjectTrusted(),
								};
							},
						}),
						paths: {
							global: `${homeTilde(path.join(getAgentDir(), "settings.json"))} (MCP: its mcp.json)`,
							project: `${path.join(CONFIG_DIR_NAME, "settings.json")} (MCP: ${path.join(CONFIG_DIR_NAME, "mcp.json")})`,
						},
						height: () => Math.max(8, (process.stdout.rows ?? 24) - 4),
						done: (changed) => {
							closed = true;
							done(changed);
						},
						requestRender: () => tui.requestRender(),
					},
					theme,
					keybindings,
				);
				beginLoad();
				return view;
			});
		} finally {
			closed = true;
		}
		if (!loaded) return;
		const { manager } = loaded;
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
			lines: settingsChanged
				? [successNotice("Saved", "switches"), ...(harnessSwitched ? [await reloadMcp(api)] : [])]
				: [],
			failed: false,
			settingsChanged,
			mcpChanges,
		});
	}

	commands.add("harness", {
		description: "Other agents' skills, MCPs, hooks and plugins",
		argumentHint: "[overview|skills|mcp|hooks|sources|extensions|list|install|update|remove|config]",
		// `enable` and `disable` stay so their moved-to-/configuration hint still shows.
		argumentWords: [...SUBCOMMANDS.map(([name]) => name), "enable", "disable"],
		dialog: "interaction",
		complete: (prefix): AutocompleteItem[] | null => {
			const match = /^(\S+)\s+(.*)$/s.exec(prefix);
			if (!match) return wordCompletions(SUBCOMMANDS, prefix);
			const [, action, rest] = match;
			const prefixWith = (items: AutocompleteItem[] | null) =>
				items?.map((item) => ({ ...item, value: `${action} ${item.value}` })) ?? null;
			if (action === "list") return prefixWith(wordCompletions(Object.keys(SECTIONS), rest));
			if (action === "hooks") return prefixWith(wordCompletions(["events", "test"], rest));
			return null;
		},
		handler: async (args, ctx) => {
			const [action = "", ...words] = args.split(/\s+/).filter(Boolean);
			if (action === "enable" || action === "disable") {
				const { manager } = await load(ctx);
				const catalog = createConfiguration({
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					settings: manager,
					projectTrusted: ctx.isProjectTrusted(),
				});
				return say(ctx, await switchMoved(action, words, catalog), "warning");
			}
			if (MARKETPLACE_ACTIONS.includes(action)) return marketplace([action, ...words], ctx);
			if (action === "hooks" && !words.length && ctx.mode === "tui" && ctx.hasUI) return picker(ctx, "hooks");
			if (action === "hooks") {
				if (words[0] === "events" && words.length === 1) return say(ctx, hookEventsReport());
				if (words[0] === "test") return say(ctx, await hooks.testRun(ctx, words.slice(1)));
				if (words.length)
					return say(
						ctx,
						'Usage: /harness hooks [events|test <Event> ...] (test runs the hooks once on a sample event; the rest is inspection only). Switch hooks with /configuration enable|disable hook:<id> (IDs: /configuration list hook); "disableAllHooks": true in a hook file turns them all off.',
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
			const section = PICKER_SECTIONS.includes(action) && !words.length ? (action as HarnessSection) : undefined;
			if (action && !section) return say(ctx, USAGE, "warning");
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const { inventory } = await load(ctx);
				const keep = section && SECTIONS[section];
				return say(ctx, renderInventory(inventory, keep ? inventory.items.filter(keep) : undefined));
			}
			return picker(ctx, section);
		},
	});
}

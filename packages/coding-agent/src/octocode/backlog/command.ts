import type { FeatureSetup, CommandContext } from "../../core/features/index.ts";
import { type Subcommand, say, wordCompletions } from "../shared/commands.ts";
import { openTarget } from "@octocodeai/octocode-common/open-target";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { doItPrompt } from "./actions.ts";
import { type Backlog, openBacklog, userActor } from "./context.ts";
import { boardText, isState, itemLine } from "./format.ts";
import { taskLine } from "./task-format.ts";
import { TASK_STATES, isOpenTask } from "@octocodeai/octocode-contracts/backlogs";
import { exportBacklog, exportBacklogHtml } from "./command/export-files.ts";
import { type CommandDeps, createItemActions, detail } from "./command/item-actions.ts";
import { refText } from "./row.ts";
import { type Item, parseRef } from "./store.ts";
import { STATES } from "@octocodeai/octocode-contracts/snapshot";

const OPEN_TASKS = TASK_STATES.filter(isOpenTask);

export function backlogCommand(api: FeatureSetup, deps: CommandDeps): Subcommand {
	const doWeb = async (ctx: CommandContext, backlog: Backlog): Promise<void> => {
		// The same page as `/web backlogs` where that command is registered: the web daemon's, or this session's own.
		const web = deps.web?.();
		if (web) return web.handler("backlogs", ctx);
		const url = await deps.openView(ctx, backlog);
		say(ctx, `Opened the live backlog board at ${url}\nChanges are saved; keep this session open.`);
	};

	const { apply, handOff, move, closeItem, add, actions, tasks } = createItemActions(api, deps);

	const doExport = (ctx: CommandContext, backlog: Backlog) => {
		try {
			say(
				ctx,
				`Exported the backlog to ${exportBacklog(backlog, ctx.cwd)} (a snapshot; edits there are not read back).`,
			);
		} catch (error) {
			say(ctx, `Export failed: ${errorMessage(error)}`, "error");
		}
	};

	/** Writes the HTML page and, with a UI, opens it in the default browser. */
	const doHtml = async (ctx: CommandContext, backlog: Backlog): Promise<void> => {
		let file: string;
		try {
			file = exportBacklogHtml(backlog, ctx.cwd);
		} catch (error) {
			return say(ctx, `HTML export failed: ${errorMessage(error)}`, "error");
		}
		const snapshot = "a snapshot, not live: run /backlog html to refresh it";
		if (!ctx.hasUI) return say(ctx, `Wrote ${file} (${snapshot}). Open it in a browser.`);
		try {
			await (deps.open ?? openTarget)(file);
			say(ctx, `Opened ${file} in your browser (${snapshot}).`);
		} catch (error) {
			say(ctx, `Wrote ${file} but could not open it: ${errorMessage(error)}`, "warning");
		}
	};

	/** The TUI board; loops back to it after each action until the user closes it or hands an item to the agent. */
	const board = async (ctx: CommandContext, backlog: Backlog): Promise<void> => {
		// Loaded on open: the board paints with the terminal UI package, which a headless session never loads.
		const { showBoard } = await import("./board.ts");
		let selected: string | undefined;
		for (;;) {
			const choice = await showBoard(
				ctx,
				{
					title: `Backlog — ${backlog.repoName}`,
					self: backlog.session,
					load: () => backlog.store.list().items,
					marks: (items) => backlog.store.marks(items, backlog.session),
					revision: () => backlog.store.revision,
					changed: () => deps.changed(ctx),
					tasks: {
						load: () => backlog.store.tasks.list({ states: OPEN_TASKS }),
						move: (task, state) => tasks.step(ctx, backlog, task, state),
					},
					move: (item, state) =>
						state === "done" || item.state === "done"
							? Promise.resolve("Open the item actions to complete or reopen with a result/reason.")
							: apply(ctx, backlog, () =>
									backlog.store.update(item.ref, { state, version: item.version }, userActor(backlog)),
								),
				},
				selected,
			);
			if (!choice) return;
			if (choice.action === "add") await add(ctx, backlog, "");
			else if (choice.action === "export") doExport(ctx, backlog);
			else if (choice.action === "html") await doHtml(ctx, backlog);
			else if (choice.action === "task") {
				selected = choice.ref;
				await tasks.actions(ctx, backlog, choice.ref);
			} else {
				selected = choice.ref;
				const item = backlog.store.get(choice.ref);
				if (choice.action === "do" && item) {
					if (await handOff(ctx, backlog, item, doItPrompt)) return;
				} else if (await actions(ctx, backlog, choice.ref)) return;
			}
		}
	};

	/** Without a custom component (RPC): the board as a select list. */
	const selectBoard = async (ctx: CommandContext, backlog: Backlog): Promise<void> => {
		const ADD = "+ Add an item";
		const EXPORT = "Export to .octocode/code/backlog.md";
		const HTML = "Open as HTML";
		for (;;) {
			const items = backlog.store.list().items;
			const open = backlog.store.tasks.list({ states: OPEN_TASKS });
			const lines = items.map((item) => itemLine(item, backlog.session));
			const taskLines = open.map((task) => `  ${taskLine(task)}`);
			const choice = await ctx.ui.select(`Backlog — ${backlog.repoName}`, [ADD, ...lines, ...taskLines, EXPORT, HTML]);
			if (choice === undefined) return;
			if (choice === ADD) await add(ctx, backlog, "");
			else if (choice === EXPORT) doExport(ctx, backlog);
			else if (choice === HTML) await doHtml(ctx, backlog);
			else if (taskLines.includes(choice)) await tasks.actions(ctx, backlog, open[taskLines.indexOf(choice)].ref);
			else {
				const item = items[lines.indexOf(choice)];
				if (item && (await actions(ctx, backlog, item.ref))) return;
			}
		}
	};

	// These definitions own dispatch, help and completion. Item states remain owned by the store.
	const verbs: Record<
		string,
		{
			args: string;
			description: string;
			run(ctx: CommandContext, backlog: Backlog, args: string): void | Promise<void>;
		}
	> = {
		web: { args: "", description: "open the live local board", run: doWeb },
		tui: {
			args: "",
			description: "open the interactive terminal board",
			run: async (ctx, backlog, args) => {
				if (args) return say(ctx, "Usage: /backlog tui", "warning");
				if (ctx.hasUI && ctx.mode === "tui") return board(ctx, backlog);
				if (ctx.hasUI) return selectBoard(ctx, backlog);
				say(ctx, boardText(backlog.store, backlog.session));
			},
		},
		add: { args: "<title>", description: "a new todo item", run: add },
		do: {
			args: "<id>",
			description: "hand an item to the agent now",
			run: async (ctx, backlog, ref) => {
				if (!ref) return say(ctx, "Usage: /backlog do <id>", "warning");
				const item = backlog.store.get(ref);
				if (!item) return say(ctx, `No backlog item ${ref}.`, "warning");
				await handOff(ctx, backlog, item, doItPrompt);
			},
		},
		export: {
			args: "",
			description: "write .octocode/code/backlog.md",
			run: (ctx, backlog, args) => {
				if (args) return say(ctx, "Usage: /backlog export", "warning");
				doExport(ctx, backlog);
			},
		},
		html: {
			args: "",
			description: "write .octocode/code/backlog.html and open it in the browser",
			run: (ctx, backlog, args) => {
				if (args) return say(ctx, "Usage: /backlog html", "warning");
				return doHtml(ctx, backlog);
			},
		},
	};
	const itemActions = [...STATES, "close"];
	const syntax = Object.entries(verbs).map(([name, verb]) => `${name}${verb.args ? ` ${verb.args}` : ""}`);
	const usage = `[${[...syntax, `<id> [${itemActions.join("|")}]`].join(" | ")}]`;
	return {
		description: "Open the backlog board (web; tui: in the terminal)",
		argumentHint: usage,
		complete: (prefix) => {
			const words = prefix.split(/\s+/);
			let items: Item[] = [];
			try {
				items = deps.items();
			} catch {
				/* Completion remains available without the database. */
			}
			const refs: [string, string][] = items.map((item) => [
				refText(item.seq),
				`${sanitizeTerminalText(item.title)} — ${item.state}`,
			]);
			if (words[0] === "do" && words.length === 2)
				return wordCompletions(refs, words[1])?.map((item) => ({ ...item, value: `do ${item.value}` })) ?? null;
			if (words.length <= 1)
				return wordCompletions(
					[
						...refs,
						...Object.entries(verbs).map(([name, verb]): [string, string] => [
							name,
							`${name}${verb.args ? ` ${verb.args}` : ""} — ${verb.description}`,
						]),
					],
					prefix,
				);
			if (words.length === 2 && parseRef(words[0]) !== undefined)
				return (
					wordCompletions(itemActions, words[1])?.map((item) => ({
						...item,
						value: `${words[0]} ${item.value}`,
					})) ?? null
				);
			return null;
		},
		async handler(args, ctx) {
			let backlog: Backlog;
			try {
				backlog = openBacklog(ctx, deps);
			} catch (error) {
				return say(ctx, `Backlog unavailable: ${errorMessage(error)}`, "error");
			}
			const line = args.trim();
			const [word = "", ...rest] = line.split(/\s+/);
			const tail = line.slice(word.length).trim();
			try {
				if (word === "") {
					if (ctx.hasUI) return await doWeb(ctx, backlog);
					return say(ctx, boardText(backlog.store, backlog.session));
				}
				const command = Object.hasOwn(verbs, word) ? verbs[word] : undefined;
				if (command) return await command.run(ctx, backlog, tail);
				if (rest.length > 1) return say(ctx, `Usage: /backlog ${usage}`, "warning");
				const item = backlog.store.get(word);
				if (!item) return say(ctx, `Unknown backlog item or subcommand "${word}". Usage: /backlog ${usage}`, "warning");
				const verb = rest[0];
				if (verb === undefined) {
					if (ctx.hasUI) {
						await actions(ctx, backlog, item.ref);
						return;
					}
					return say(ctx, detail(backlog, item));
				}
				if (isState(verb)) {
					const refused = await move(ctx, backlog, item, verb);
					return refused
						? say(ctx, refused, "warning")
						: say(ctx, `Moved ${itemLine(backlog.store.get(item.ref)!, backlog.session)}`);
				}
				if (verb === "close") {
					if (!ctx.hasUI) return say(ctx, "Closing asks for a reason: run it in the interactive UI.", "warning");
					return await closeItem(ctx, backlog, item);
				}
				return say(ctx, `Unknown action "${verb}". Usage: /backlog ${usage}`, "warning");
			} catch (error) {
				say(ctx, errorMessage(error), "error");
			}
		},
	};
}

import { doItPrompt, delegatePrompt } from "./actions.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { USER_AUTHOR } from "../agentdb/author.ts";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { type Subcommand, say, wordCompletions } from "../shared/commands.ts";
import { workspacePaths } from "../shared/home.ts";
import { openFile } from "../shared/open.ts";
import { sanitizeTerminalText } from "../shared/sanitize.ts";
import { errorMessage } from "../shared/util.ts";
import { showBoard } from "./board.ts";
import { type Backlog, type BacklogOptions, openBacklog } from "./context.ts";
import { boardText, exportMarkdown, isState, itemDetail, itemLine } from "./format.ts";
import { renderBacklogHtml } from "./html.ts";
import { refText } from "./row.ts";
import { backlogSnapshot } from "./snapshot.ts";
import { type Item, PRIORITIES, parseRef, STATES, type UpdateInput } from "./store.ts";

/** The fields `Edit` changes, one per editor: the text shown for an item, and the store update for the text saved (a list has one entry per line). */
const EDITABLE: Record<string, { text(item: Item): string; patch(text: string): UpdateInput }> = {
	Type: { text: (item) => item.type, patch: (text) => ({ type: text as Item["type"] }) },
	Parent: { text: (item) => item.parentId ?? "", patch: (text) => ({ parentId: text || null }) },
	Dependencies: {
		text: (item) => item.dependsOn.map((r) => r.id).join("\n"),
		patch: (text) => ({ dependsOn: text.split(/[\s,]+/).filter(Boolean) }),
	},
	Title: { text: (item) => item.title, patch: (text) => ({ title: text }) },
	Goal: { text: (item) => item.goal, patch: (text) => ({ goal: text }) },
	Body: { text: (item) => item.body, patch: (text) => ({ body: text }) },
	Paths: { text: (item) => item.paths.join("\n"), patch: (text) => ({ paths: text.split("\n") }) },
	Reason: { text: (item) => item.why, patch: (text) => ({ why: text }) },
	Evidence: { text: (item) => item.evidence.join("\n"), patch: (text) => ({ evidence: text.split("\n") }) },
	Plan: { text: (item) => item.plan, patch: (text) => ({ plan: text }) },
};

/** The full detail the user sees: origin, the items that came from it, and the latest notes and changes. */
function detail(backlog: Backlog, item: Item, notes = 10): string {
	const origin = item.from === undefined ? undefined : backlog.store.get(item.from);
	const options = {
		self: backlog.session,
		version: true,
		...(origin ? { origin } : {}),
		derived: backlog.store.derived(item),
	};
	return itemDetail(item, backlog.store.notes(item, notes), backlog.store.noteCount(item), Date.now(), options);
}

/** Writes `content` atomically to `<repo>/.octocode/<name>` (the folder is made when missing) and returns the path. */
function writeSnapshot(cwd: string, name: string, content: string): string {
	const { dir } = workspacePaths(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	atomicWriteFileSync(file, content);
	return file;
}

/** Writes `<repo>/.octocode/backlog.md` and returns its path. */
const exportBacklog = (backlog: Backlog, cwd: string, now = Date.now()): string =>
	writeSnapshot(cwd, "backlog.md", exportMarkdown(backlog.store, backlog.repoName, now));

/** Writes `<repo>/.octocode/backlog.html` (every item and note, refused when any text looks like a secret) and returns its path. */
const exportBacklogHtml = (backlog: Backlog, cwd: string, now = Date.now()): string =>
	writeSnapshot(
		cwd,
		"backlog.html",
		renderBacklogHtml(backlogSnapshot(backlog.store, backlog.repoName, now, backlog.session)),
	);

interface CommandDeps extends BacklogOptions {
	items(): Item[];
	openView(ctx: ExtensionCommandContext, backlog: Backlog): Promise<void>;
	/** Opens a file in the default application; replaceable so a test opens nothing. */
	open?: (file: string) => Promise<void>;
	/** Repaint the footer counts after a change. */
	changed(ctx: ExtensionCommandContext): void;
}

/** The `/backlog` subcommand (and its `/backlog` alias). */
export function backlogCommand(pi: ExtensionAPI, deps: CommandDeps): Subcommand {
	const doWeb = async (ctx: ExtensionCommandContext, backlog: Backlog): Promise<void> => {
		await deps.openView(ctx, backlog);
		say(ctx, "Opened the live backlog board. Changes are saved; keep this session open.");
	};

	/** Runs one store change and repaints; returns the refusal text instead of throwing. */
	const apply = (ctx: ExtensionCommandContext, change: () => void): string | undefined => {
		try {
			change();
			deps.changed(ctx);
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	};
	/** `apply`, telling the user the outcome (`done` on success, the refusal as a warning). */
	const applyAndSay = (ctx: ExtensionCommandContext, change: () => void, done?: string): void => {
		const refused = apply(ctx, change);
		if (refused) say(ctx, refused, "warning");
		else if (done) say(ctx, done);
	};

	/** Mark `item` ongoing for this session and hand it to the agent, now or after the current run. */
	const handOff = (
		ctx: ExtensionCommandContext,
		backlog: Backlog,
		item: Item,
		prompt: (item: Item) => string,
	): boolean => {
		let claimed!: Item;
		try {
			backlog.store.dispatch(item.ref, item.version, { ...backlog.actor, kind: "human" }, (next) => {
				claimed = next;
				pi.sendUserMessage(prompt(next), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			});
		} catch (error) {
			say(ctx, errorMessage(error), "warning");
			return false;
		}
		deps.changed(ctx);
		if (!ctx.isIdle()) say(ctx, `${claimed.ref} is queued: the agent starts it after the current run.`);
		return true;
	};

	// The user's own move: may override another live session's hold (claiming it as ongoing is still refused).
	const move = async (
		ctx: ExtensionCommandContext,
		backlog: Backlog,
		item: Item,
		state: (typeof STATES)[number],
	): Promise<string | undefined> => {
		const patch: UpdateInput = { state, version: item.version, force: true };
		if (state === "ongoing" || state === "done") {
			if (!item.why) {
				const reason = await ctx.ui.input("Why does this matter?");
				if (!reason) return "Move cancelled: reason needed.";
				patch.reason = reason;
			}
			if (!item.goal) {
				const goal = await ctx.ui.input("What result means done?");
				if (!goal) return "Move cancelled: goal needed.";
				patch.goal = goal;
			}
		}
		if (state === "done" && item.state !== "done") {
			const summary = await ctx.ui.input("What changed?");
			if (!summary) return "Completion cancelled.";
			const files = await ctx.ui.input("Related files (comma separated; empty for none)");
			if (files === undefined) return "Completion cancelled.";
			patch.completion = {
				summary,
				files: files
					.split(",")
					.map((p) => p.trim())
					.filter(Boolean)
					.map((path) => ({ path, role: "changed" })),
				verification: { status: "not_run", summary: "Manually completed without recorded verification." },
				operationKey: randomUUID(),
			};
		}
		if (item.state === "done" && state !== "done") {
			const note = await ctx.ui.input("Why reopen?");
			if (!note) return "Reopen cancelled.";
			patch.note = note;
		}
		return apply(ctx, () => backlog.store.update(item.ref, patch, { ...backlog.actor, kind: "human" }));
	};

	/** Deletes `item` after the user confirms (`detail` is the dialog text). */
	const remove = async (ctx: ExtensionCommandContext, backlog: Backlog, item: Item, detail: string): Promise<void> => {
		if (!(await ctx.ui.confirm(`Delete ${item.ref}?`, detail))) return;
		applyAndSay(ctx, () => backlog.store.remove(item.ref, item.version), `Deleted ${item.ref}.`);
	};

	const add = async (ctx: ExtensionCommandContext, backlog: Backlog, given: string): Promise<void> => {
		const title = given || (ctx.hasUI ? ((await ctx.ui.input("New backlog item", "title"))?.trim() ?? "") : "");
		if (!title) return say(ctx, "Usage: /backlog add <title>", given || !ctx.hasUI ? "warning" : "info");
		let item: Item;
		try {
			item = backlog.store.add({
				title,
				state: "todo",
				createdBy: USER_AUTHOR,
				sourceSession: backlog.session,
			});
		} catch (error) {
			return say(ctx, `Not added: ${errorMessage(error)}`, "warning");
		}
		deps.changed(ctx);
		say(ctx, `Added ${itemLine(item, backlog.session)}`);
	};

	const edit = async (ctx: ExtensionCommandContext, backlog: Backlog, item: Item): Promise<void> => {
		const name = await ctx.ui.select(`Edit which field of ${item.ref}?`, Object.keys(EDITABLE));
		const field = name === undefined ? undefined : EDITABLE[name];
		if (!name || !field) return;
		const hint = name === "Paths" || name === "Evidence" ? " (one per line)" : "";
		const text = await ctx.ui.editor(`Edit the ${name.toLowerCase()} of ${item.ref}${hint}`, field.text(item));
		if (text === undefined) return;
		const patch = field.patch(text.trim());
		if (name === "Title" && !patch.title) return say(ctx, "Not saved: the title is empty.", "warning");
		applyAndSay(ctx, () =>
			backlog.store.update(
				item.ref,
				{ ...patch, version: item.version, force: true },
				{ ...backlog.actor, kind: "human" },
			),
		);
	};

	/** The action menu for one item; returns true when the item went to the agent (the board then closes). */
	const actions = async (ctx: ExtensionCommandContext, backlog: Backlog, ref: string): Promise<boolean> => {
		const item = backlog.store.get(ref);
		if (!item) {
			say(ctx, `No backlog item ${ref}.`, "warning");
			return false;
		}
		// Octocode's select returns a label. Keep that label and its behavior together, with one dispatch at the UI boundary.
		const choices: Array<{ label: string; run(): boolean | undefined | Promise<boolean | undefined> }> = [
			{ label: "Do it now", run: () => handOff(ctx, backlog, item, doItPrompt) },
			{ label: "Delegate to a subagent", run: () => handOff(ctx, backlog, item, delegatePrompt) },
			{
				label: "Move to…",
				run: async () => {
					const state = await ctx.ui.select(
						`Move ${item.ref} to`,
						STATES.filter((state) => state !== item.state),
					);
					const refused = state && isState(state) ? await move(ctx, backlog, item, state) : undefined;
					if (refused) say(ctx, refused, "warning");
				},
			},
			{
				label: "Edit",
				run: async () => {
					await edit(ctx, backlog, item);
					return undefined;
				},
			},
			{
				label: "Priority…",
				run: async () => {
					const priority = await ctx.ui.select(`Priority of ${item.ref}`, [...PRIORITIES]);
					const index = (PRIORITIES as readonly string[]).indexOf(priority ?? "");
					if (index >= 0)
						applyAndSay(ctx, () =>
							backlog.store.update(item.ref, { priority: index, version: item.version, force: true }, backlog.actor),
						);
				},
			},
			{
				label: "Came from…",
				run: async () => {
					const ref = await ctx.ui.input(
						`${item.ref} came from (empty clears)`,
						item.from === undefined ? "B12" : refText(item.from),
					);
					if (ref !== undefined)
						applyAndSay(ctx, () =>
							backlog.store.update(
								item.ref,
								{ from: ref.trim() === "" ? null : ref.trim(), version: item.version, force: true },
								backlog.actor,
							),
						);
				},
			},
			{
				label: "Show notes and changes",
				run: () => {
					say(ctx, detail(backlog, item, 50));
					return undefined;
				},
			},
			{
				label: "Delete",
				run: async () => {
					await remove(
						ctx,
						backlog,
						item,
						`${sanitizeTerminalText(item.title)}\n\nThe item and its notes are removed for every session.`,
					);
					return undefined;
				},
			},
		];
		const choice = await ctx.ui.select(
			itemLine(item, backlog.session),
			choices.map(({ label }) => label),
		);
		return (await choices.find(({ label }) => label === choice)?.run()) === true;
	};

	const doExport = (ctx: ExtensionCommandContext, backlog: Backlog) => {
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
	const doHtml = async (ctx: ExtensionCommandContext, backlog: Backlog): Promise<void> => {
		let file: string;
		try {
			file = exportBacklogHtml(backlog, ctx.cwd);
		} catch (error) {
			return say(ctx, `HTML export failed: ${errorMessage(error)}`, "error");
		}
		const snapshot = "a snapshot, not live: run /backlog html to refresh it";
		if (!ctx.hasUI) return say(ctx, `Wrote ${file} (${snapshot}). Open it in a browser.`);
		try {
			await (deps.open ?? openFile)(file);
			say(ctx, `Opened ${file} in your browser (${snapshot}).`);
		} catch (error) {
			say(ctx, `Wrote ${file} but could not open it: ${errorMessage(error)}`, "warning");
		}
	};

	/** The TUI board; loops back to it after each action until the user closes it or hands an item to the agent. */
	const board = async (ctx: ExtensionCommandContext, backlog: Backlog): Promise<void> => {
		let selected: string | undefined;
		for (;;) {
			const choice = await showBoard(
				ctx,
				{
					title: `Backlog — ${backlog.repoName}`,
					self: backlog.session,
					load: () => backlog.store.list().items,
					move: (item, state) =>
						state === "done" || item.state === "done"
							? "Open the item actions to complete or reopen with a result/reason."
							: apply(ctx, () =>
									backlog.store.update(item.ref, { state, version: item.version }, { ...backlog.actor, kind: "human" }),
								),
				},
				selected,
			);
			if (!choice) return;
			if (choice.action === "add") await add(ctx, backlog, "");
			else if (choice.action === "export") doExport(ctx, backlog);
			else if (choice.action === "html") await doHtml(ctx, backlog);
			else {
				selected = choice.ref;
				const item = backlog.store.get(choice.ref);
				if (choice.action === "do" && item) {
					if (handOff(ctx, backlog, item, doItPrompt)) return;
				} else if (await actions(ctx, backlog, choice.ref)) return;
			}
		}
	};

	/** Without a custom component (RPC): the board as a select list. */
	const selectBoard = async (ctx: ExtensionCommandContext, backlog: Backlog): Promise<void> => {
		const ADD = "+ Add an item";
		const EXPORT = "Export to .octocode/backlog.md";
		const HTML = "Open as HTML";
		for (;;) {
			const items = backlog.store.list().items;
			const lines = items.map((item) => itemLine(item, backlog.session));
			const choice = await ctx.ui.select(`Backlog — ${backlog.repoName}`, [ADD, ...lines, EXPORT, HTML]);
			if (choice === undefined) return;
			if (choice === ADD) await add(ctx, backlog, "");
			else if (choice === EXPORT) doExport(ctx, backlog);
			else if (choice === HTML) await doHtml(ctx, backlog);
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
			run(ctx: ExtensionCommandContext, backlog: Backlog, args: string): void | Promise<void>;
		}
	> = {
		web: { args: "", description: "open the live local board", run: doWeb },
		tui: {
			args: "",
			description: "open the interactive terminal board",
			run: async (ctx, backlog, args) => {
				if (args) return say(ctx, "Usage: /backlog tui", "warning");
				if (ctx.hasUI && ctx.mode === "tui") return await board(ctx, backlog);
				if (ctx.hasUI) return await selectBoard(ctx, backlog);
				say(ctx, boardText(backlog.store, backlog.session));
			},
		},
		add: { args: "<title>", description: "a new todo item", run: add },
		do: {
			args: "<id>",
			description: "hand an item to the agent now",
			run: (ctx, backlog, ref) => {
				if (!ref) return say(ctx, "Usage: /backlog do <id>", "warning");
				const item = backlog.store.get(ref);
				if (!item) return say(ctx, `No backlog item ${ref}.`, "warning");
				handOff(ctx, backlog, item, doItPrompt);
			},
		},
		export: {
			args: "",
			description: "write .octocode/backlog.md",
			run: (ctx, backlog, args) => {
				if (args) return say(ctx, "Usage: /backlog export", "warning");
				doExport(ctx, backlog);
			},
		},
		html: {
			args: "",
			description: "write .octocode/backlog.html and open it in the browser",
			run: (ctx, backlog, args) => {
				if (args) return say(ctx, "Usage: /backlog html", "warning");
				return doHtml(ctx, backlog);
			},
		},
	};
	const itemActions = [...STATES, "delete"];
	const syntax = Object.entries(verbs).map(([name, verb]) => `${name}${verb.args ? ` ${verb.args}` : ""}`);
	const usage = `backlog [${[...syntax, `<id> [${itemActions.join("|")}]`].join(" | ")}]`;
	return {
		description: `${usage} — the repository task board`,
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
				return wordCompletions(refs, words[1]!)?.map((item) => ({ ...item, value: `do ${item.value}` })) ?? null;
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
			if (words.length === 2 && parseRef(words[0]!) !== undefined)
				return (
					wordCompletions(itemActions, words[1]!)?.map((item) => ({
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
				if (rest.length > 1) return say(ctx, `Usage: /${usage}`, "warning");
				const item = backlog.store.get(word);
				if (!item) return say(ctx, `Unknown backlog item or subcommand "${word}". Usage: /${usage}`, "warning");
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
				if (verb === "delete") {
					if (!ctx.hasUI) return say(ctx, "Deleting needs a confirmation: run it in the interactive UI.", "warning");
					return await remove(ctx, backlog, item, sanitizeTerminalText(item.title));
				}
				return say(ctx, `Unknown action "${verb}". Usage: /${usage}`, "warning");
			} catch (error) {
				say(ctx, errorMessage(error), "error");
			}
		},
	};
}

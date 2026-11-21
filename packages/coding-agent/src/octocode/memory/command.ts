import type { CommandContext } from "../../core/features/index.ts";
import { USER_AUTHOR } from "../../../../db/src/api.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { confirmAction, successNotice } from "../shared/page.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type MemoryFileSync, syncDeletedMemory, syncSavedMemory } from "./file/sync.ts";
import { lastInjection } from "./inject.ts";
import { ADD_ROW, memoryDetailPage, memoryListPage, sectionOf } from "./page.ts";
import { memoryLabel } from "./query.ts";
import { MemoryChangedError } from "./errors.ts";
import {
	MEMORY_KINDS,
	describeMemory,
	type Memory,
	MemoryError,
	type MemoryInput,
	type MemoryKind,
	type MemoryStore,
	memoryAge,
	memoryLine,
} from "./store.ts";

const LIST_LIMIT = 100;
const ADD = "+ Add a memory";
/** `/memory review` without a number: memories not updated in this many days are due. */
const REVIEW_DAYS = 30;

/** The editor template `add` and Edit open: header lines, a `---` line, then the body. */
export function memoryTemplate(
	memory?: Pick<Memory, "title" | "kind" | "keywords" | "scope" | "body" | "pinned">,
): string {
	return [
		`title: ${memory?.title ?? ""}`,
		`kind: ${memory?.kind ?? "fact"}  # ${MEMORY_KINDS.join(" | ")}`,
		`scope: ${memory?.scope ?? "workspace"}  # workspace | project | global`,
		`keywords: ${memory?.keywords ?? ""}`,
		`pinned: ${memory?.pinned ? "yes" : "no"}`,
		"---",
		memory?.body ?? "",
	].join("\n");
}

/** The fields of an edited template; unknown header lines are ignored, a bad kind or scope is an error. */
export function parseTemplate(text: string): MemoryInput {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const split = lines.findIndex((line) => line.trim() === "---");
	const header = split === -1 ? lines : lines.slice(0, split);
	const body =
		split === -1
			? ""
			: lines
					.slice(split + 1)
					.join("\n")
					.trim();
	const input: MemoryInput = { body };
	for (const line of header) {
		const match = /^\s*(title|kind|scope|keywords|pinned)\s*:(.*)$/i.exec(line);
		if (!match) continue;
		const key = match[1].toLowerCase();
		const value = (key === "title" ? match[2] : match[2].replace(/#.*$/, "")).trim();
		if (key === "title") input.title = value;
		else if (key === "keywords") input.keywords = value;
		else if (key === "pinned") input.pinned = /^(y|yes|true|1|on)$/i.test(value);
		else if (key === "kind") {
			if (!(MEMORY_KINDS as readonly string[]).includes(value))
				throw new MemoryError(`kind must be one of ${MEMORY_KINDS.join(", ")}.`);
			input.kind = value as MemoryKind;
		} else if (value !== "workspace" && value !== "project" && value !== "global")
			throw new MemoryError("scope must be workspace, project or global.");
		else input.scope = value;
	}
	return input;
}

const section = sectionOf;

/** One picker option: `Pinned · M3 (project, decision, pinned) Title — body…`. */
const optionOf = (memory: Memory) => `${section(memory)} · ${memoryLine(memory, 80)}`;

/** Pinned, then project, then global memories, newest first within each. */
function grouped(memories: readonly Memory[]): Memory[] {
	const order = { Pinned: 0, Workspace: 1, Project: 2, Global: 3 };
	return [...memories].sort((a, b) => order[section(a)] - order[section(b)] || b.updatedAt - a.updatedAt);
}

function textList(memories: readonly Memory[], title: string): string {
	if (memories.length === 0) return `${title}: none.`;
	const lines = [`${title}:`];
	let current = "";
	for (const memory of grouped(memories)) {
		if (section(memory) !== current) {
			current = section(memory);
			lines.push(`${current}:`);
		}
		lines.push(`  ${memoryLine(memory, 120)}`);
	}
	return lines.join("\n");
}

/** What `/memory` reads beside the store: the recall switch of the environment, and the MEMORY.md files' settings. */
interface MemoryCommandDeps {
	store: (ctx: CommandContext) => MemoryStore;
	autoEnv: () => boolean;
	sync: MemoryFileSync;
}

/**
 * A user's change reaches the MEMORY.md files too (a user command needs no approval): what changed there, as lines to
 * end the command's message with ("" when nothing did).
 */
async function fileNote(
	ctx: CommandContext,
	store: MemoryStore,
	deps: MemoryCommandDeps,
	before: Memory | undefined,
	after: Memory | undefined,
): Promise<string> {
	const change = { store, cwd: ctx.cwd, approved: true };
	const note = after
		? await syncSavedMemory(deps.sync, { ...change, before, saved: after })
		: before
			? await syncDeletedMemory(deps.sync, { ...change, removed: before })
			: "";
	return note ? `\n${note}` : "";
}

/**
 * `/memory`: browse (pinned/project/global), `search <q>`, `add [title]`, `auto`, `last`, `review [days]`. The TUI picks with `ui.select` and edits in `ui.editor`; without a UI every form prints text.
 */
export function registerMemoryCommand(commands: Subcommands, deps: MemoryCommandDeps): void {
	commands.add("memory", {
		description: "Browse and edit durable memories",
		complete: (prefix) =>
			wordCompletions(
				[
					["search ", "find memories"],
					["add", "write a memory"],
					["auto", "automatic recall status"],
					["last", "what was injected last"],
					["review", "unused or stale memories"],
				],
				prefix,
			),
		handler: async (args, ctx) => {
			try {
				await run(args, ctx, deps.store(ctx), deps);
			} catch (error) {
				say(ctx, `memory: ${errorMessage(error)}`, error instanceof MemoryError ? "warning" : "error");
			}
		},
	});
}

async function run(args: string, ctx: CommandContext, store: MemoryStore, deps: MemoryCommandDeps): Promise<void> {
	const [verb = "", ...restWords] = args.trim().split(/\s+/);
	const rest = restWords.join(" ").trim();
	if (verb === "auto")
		return say(
			ctx,
			`Automatic recall is ${autoStatus(deps)}. Change it with /configuration set memory.recall off|main|all (add --local for this project).`,
			"info",
		);
	if (verb === "last") {
		const last = lastInjection(ctx.sessionManager.getBranch());
		return say(ctx, last ?? "No memories were injected on this branch yet.", "info");
	}
	if (verb === "add") return add(ctx, store, rest, deps);
	if (verb === "review") return review(ctx, store, rest, deps);
	if (verb === "search") {
		if (!rest) return say(ctx, "Usage: /memory search <words>", "warning");
		return browse(
			ctx,
			store,
			store.search(rest, "all", 20),
			`Memories matching "${rest}"`,
			deps,
			`no memory matches "${rest}"`,
		);
	}
	if (verb === "" || verb === "list")
		return browse(ctx, store, store.list("all", LIST_LIMIT), `Memories (recall ${autoStatus(deps)})`, deps);
	return say(ctx, "Usage: /memory [search <q>|add|auto|last|review [days]]", "warning");
}

/**
 * `/memory review [days]`: memories never injected, or not updated in `days` (default 30), oldest first. The TUI opens
 * them in the browser, whose Edit and Delete act on one; headless, each line says why it is listed.
 */
async function review(ctx: CommandContext, store: MemoryStore, rest: string, deps: MemoryCommandDeps): Promise<void> {
	const days = rest ? Number(rest) : REVIEW_DAYS;
	if (!Number.isInteger(days) || days < 1) return say(ctx, "Usage: /memory review [days]", "warning");
	const now = Date.now();
	const due = store.review(days, "all", LIST_LIMIT, now);
	const title = `Memories never used or not updated in ${days} days`;
	if (due.length === 0) return say(ctx, `${title}: none.`, "info");
	if (ctx.hasUI) return browse(ctx, store, due, `${title} (pick one to edit or delete)`, deps);
	const why = (memory: Memory) =>
		[...(memory.useCount === 0 ? ["never used"] : []), `updated ${memoryAge(memory, now)} ago`].join(", ");
	return say(
		ctx,
		[
			`${title}:`,
			...due.map((memory) => `  ${memoryLine(memory, 80)} (${why(memory)})`),
			"Edit or delete one in the TUI: /memory, then pick it.",
		].join("\n"),
		"info",
	);
}

/** `memory.recall`, unless the environment turned recall off for the process. */
const autoStatus = (deps: Pick<MemoryCommandDeps, "autoEnv" | "sync">) =>
	!deps.autoEnv() ? "off (OCTOCODE_MEMORY_AUTO=0)" : deps.sync.settings().recall;

async function add(ctx: CommandContext, store: MemoryStore, text: string, deps: MemoryCommandDeps): Promise<void> {
	const sourceSession = ctx.sessionManager.getSessionId();
	if (!ctx.hasUI) {
		if (!text) return say(ctx, "Usage: /memory add <title> [— body]", "warning");
		const [title = "", ...body] = text.split(/\s+[—-]{1,2}\s+/);
		const { memory } = store.set({ title, body: body.join(" — "), author: USER_AUTHOR, sourceSession });
		return say(ctx, `Saved ${memoryLine(memory, 60)}${await fileNote(ctx, store, deps, undefined, memory)}`, "info");
	}
	const saved = await editUntilValid(
		ctx,
		"New memory",
		memoryTemplate({ title: text, kind: "fact", keywords: "", scope: "workspace", body: "", pinned: false }),
		(edited) => store.set({ ...parseTemplate(edited), author: USER_AUTHOR, sourceSession }).memory,
	);
	if (saved) say(ctx, `Saved ${memoryLine(saved, 60)}${await fileNote(ctx, store, deps, undefined, saved)}`, "info");
}

/** Reopens the editor with the user's own text and the reason when it does not validate, so an edit is never lost. */
async function editUntilValid<T>(
	ctx: CommandContext,
	title: string,
	initial: string,
	save: (edited: string) => T,
): Promise<T | undefined> {
	let text = initial;
	for (;;) {
		const edited = await ctx.ui.editor(title, text);
		if (edited === undefined) return undefined;
		try {
			return save(edited);
		} catch (error) {
			if (!(error instanceof MemoryError)) throw error;
			const next =
				error instanceof MemoryChangedError
					? "Cancel this editor, read the memory again, and reapply your draft. Your draft is kept below."
					: "Fix it and save again, or cancel.";
			say(ctx, `memory: ${error.message} ${next}`, "warning");
			text = edited;
		}
	}
}

async function browse(
	ctx: CommandContext,
	store: MemoryStore,
	memories: Memory[],
	title: string,
	deps: MemoryCommandDeps,
	empty?: string,
): Promise<void> {
	if (!ctx.hasUI) return say(ctx, textList(memories, title), "info");
	let list = grouped(memories);
	let selected: string | undefined;
	for (;;) {
		let picked: Memory | undefined;
		if (ctx.mode === "tui") {
			const id = await memoryListPage(ctx, list, title, selected, empty);
			if (id === undefined) return;
			if (id === ADD_ROW) return add(ctx, store, "", deps);
			selected = id;
			picked = list.find((memory) => String(memory.id) === id);
		} else {
			const options = [...list.map(optionOf), ADD];
			const choice = await ctx.ui.select(title, options);
			if (choice === undefined) return;
			if (choice === ADD) return add(ctx, store, "", deps);
			picked = list[options.indexOf(choice)];
		}
		if (!picked) return;
		const changed = await act(ctx, store, picked, deps);
		if (changed === "closed") return;
		// Show the list again with the change applied (a deleted memory drops out).
		list = grouped(list.flatMap((memory) => (memory.id !== picked.id ? [memory] : changed ? [changed] : [])));
	}
}

/** One memory's actions. Returns the updated memory, undefined when it was deleted, or 'closed' when dismissed. */
async function act(
	ctx: CommandContext,
	store: MemoryStore,
	memory: Memory,
	deps: MemoryCommandDeps,
): Promise<Memory | undefined | "closed"> {
	const label = memoryLabel(memory.id);
	const actions = [
		"Edit",
		memory.pinned ? "Unpin" : "Pin",
		memory.scope !== "global" ? "Move to global" : "Move to this workspace",
		"Delete",
		"Show",
	];
	const action =
		ctx.mode === "tui"
			? await memoryDetailPage(ctx, memory, actions)
			: await ctx.ui.select(`${label} ${memory.title}`, actions);
	if (action === undefined) return memory;
	if (action === "Show") {
		say(ctx, describeMemory(memory), "info");
		return memory;
	}
	if (action === "Delete") {
		const question = `Delete ${label}?\n${memory.title}`;
		if (!(await confirmAction((title, options) => ctx.ui.select(title, options), question, ["Delete"]))) return memory;
		store.delete(memory.id, memory.updatedAt);
		const note = await fileNote(ctx, store, deps, memory, undefined);
		say(ctx, `${successNotice("Deleted", label, "Other memories are unchanged.")}${note}`, "info");
		return undefined;
	}
	let updated: Memory | undefined;
	if (action === "Edit") {
		updated = await editUntilValid(
			ctx,
			`Edit ${label}`,
			memoryTemplate(memory),
			(edited) =>
				store.set({ ...parseTemplate(edited), id: memory.id, author: USER_AUTHOR }, undefined, memory.updatedAt).memory,
		);
		if (!updated) return memory;
	} else {
		const input: MemoryInput =
			action === "Pin" || action === "Unpin"
				? { pinned: action === "Pin" }
				: { scope: memory.scope !== "global" ? "global" : "workspace" };
		updated = store.set({ ...input, id: memory.id, author: USER_AUTHOR }, undefined, memory.updatedAt).memory;
	}
	say(ctx, `Updated ${memoryLine(updated, 60)}${await fileNote(ctx, store, deps, memory, updated)}`, "info");
	return updated;
}

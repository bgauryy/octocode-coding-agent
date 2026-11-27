import path from "node:path";
import type { CommandContext } from "../../core/features/index.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { confirmAction, type PageSection, showCommandPage, successNotice } from "../shared/page.ts";
import type { FolderGrantView, GrantTarget } from "./grants.ts";
import {
	addTrust,
	appliesTo,
	describeAll,
	describeFolder,
	describeGrant,
	findEntry,
	GRANT_TARGETS,
	grantPath,
	liveGrants,
	removeTrust,
	TrustCommandError,
} from "./manage.ts";
import { shown } from "./messages.ts";
import { resolveFolderTrust, type TrustOptions } from "./resolve.ts";

const USAGE = "Usage: /trust [list | add [path] [--scope folder|parent|grandparent] | remove <number|path>]";

const WHAT_TRUST_ALLOWS =
	"Octocode can read and change files there, run commands, and load project instructions, settings, hooks, MCP servers, skills and plugins.";

interface Parsed {
	scope: GrantTarget;
	yes: boolean;
	rest: string;
}

/** `--scope x`, `--yes` and the remaining words (a path, or an entry number) of one `/trust` subcommand. */
function parse(words: string[]): Parsed | string {
	let scope: GrantTarget = "folder";
	let yes = false;
	const rest: string[] = [];
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index] ?? "";
		if (word === "--yes" || word === "-y") yes = true;
		else if (word === "--scope") {
			const value = words[++index] as GrantTarget | undefined;
			if (!value || !GRANT_TARGETS.includes(value)) return `--scope takes folder, parent or grandparent. ${USAGE}`;
			scope = value;
		} else rest.push(word);
	}
	return { scope, yes, rest: rest.join(" ") };
}

const surfaceOf = (ctx: CommandContext) => (ctx.hasUI ? ("tui" as const) : ("print" as const));

async function add(ctx: CommandContext, parsed: Parsed, options: TrustOptions): Promise<void> {
	const folder = parsed.rest ? path.resolve(ctx.cwd, parsed.rest) : ctx.cwd;
	const target = grantPath(folder, parsed.scope, options);
	const now = resolveFolderTrust(target, options);
	if (now.state === "trusted" && (now.root === now.path || parsed.scope === "folder"))
		return say(ctx, describeFolder(target, now, undefined));
	const reach = parsed.scope === "folder" ? "this folder" : "this folder and everything under it";
	if (!parsed.yes) {
		if (!ctx.hasUI)
			return say(
				ctx,
				"Trusting a folder needs your confirmation: run octocode trust add --yes, or /trust in a terminal.",
				"warning",
			);
		const question = `Trust ${shown(target)}?\n${WHAT_TRUST_ALLOWS} Trusts ${reach}.`;
		if (!(await confirmAction((title, options) => ctx.ui.select(title, options), question, ["Trust"])))
			return say(ctx, "Nothing was changed.");
	}
	const granted = addTrust(folder, parsed.scope, surfaceOf(ctx), options);
	say(
		ctx,
		successNotice(
			"Trusted",
			`${shown(granted.path)}${granted.scope === "subtree" ? " and everything under it" : ""}`,
			"Other decisions are unchanged.",
		),
	);
}

/** Asks, then removes. Removing the decision that lets this session run closes the session: the next open asks again. */
async function remove(ctx: CommandContext, row: FolderGrantView, yes: boolean, options: TrustOptions): Promise<void> {
	const closes = appliesTo(row, ctx.cwd, options);
	if (!yes) {
		if (!ctx.hasUI)
			return say(
				ctx,
				"Removing trust needs your confirmation: run octocode trust remove --yes, or /trust in a terminal.",
				"warning",
			);
		const question = `Remove ${row.decision === "refused" ? "the refusal for" : "trust for"} ${shown(row.path)}?\n${
			closes
				? "This is the decision that lets this session run. Octocode will close, and ask again the next time you open the folder."
				: "Octocode will ask again the next time you open that folder."
		}`;
		if (!(await confirmAction((title, options) => ctx.ui.select(title, options), question, ["Remove"])))
			return say(ctx, "Nothing was changed.");
	}
	removeTrust(row, options);
	say(
		ctx,
		successNotice(
			"Removed",
			describeGrant(row),
			closes
				? "Closing: Octocode will ask again the next time you open this folder."
				: "Other decisions are unchanged.",
		),
	);
	if (closes) ctx.shutdown();
}

/** The terminal page: decisions (each opens a detail page with Remove), then the wider folders one step from trusting. */
async function page(
	ctx: CommandContext,
	widen: Array<{ label: string; which: GrantTarget }>,
	options: TrustOptions,
): Promise<void> {
	let initialId: string | undefined;
	for (;;) {
		const live = liveGrants(options);
		const sections: PageSection[] = [
			{
				heading: "Decisions",
				rows: live.map((row) => ({
					id: `grant:${row.id}`,
					name: shown(row.path),
					detail: row.ignored ? "ignored" : row.scope === "subtree" ? "folder and below" : "this folder",
					badge: row.ignored ? "ignored" : row.decision === "refused" ? "refused" : "trusted",
					tone: row.decision === "refused" || row.ignored ? ("warning" as const) : ("success" as const),
				})),
				empty: "none yet — run /trust add to trust this folder",
			},
			{
				heading: "Trust a wider folder",
				rows: widen.map((entry) => ({
					id: `wide:${entry.which}`,
					name: entry.label.replace(/^Trust /, ""),
					detail: "trust it",
				})),
			},
		];
		const choice = await showCommandPage(ctx.ui, {
			title: "Folder trust — which folders Octocode may work in",
			notes: [describeFolder(ctx.cwd, resolveFolderTrust(ctx.cwd, options))],
			sections,
			initialId,
		});
		if (!choice) return;
		initialId = choice.id;
		const [kind, key] = choice.id.split(":");
		if (kind === "wide") await add(ctx, { scope: key as GrantTarget, yes: false, rest: "" }, options);
		else {
			const row = live.find((entry) => String(entry.id) === key);
			if (row && (await detail(ctx, row, options))) return;
		}
	}
}

/** One decision: facts and its single action. Returns true when removing it closed the session. */
async function detail(ctx: CommandContext, row: FolderGrantView, options: TrustOptions): Promise<boolean> {
	const choice = await showCommandPage(ctx.ui, {
		title: `${shown(row.path)} — ${row.decision === "refused" ? "refused" : "trusted"}`,
		facts: [{ label: "Decision", value: describeGrant(row) }],
		sections: [
			{ heading: "Actions", rows: [{ id: "remove", name: "Remove decision", detail: "Octocode asks again" }] },
		],
		nested: true,
	});
	if (!choice) return false;
	await remove(ctx, row, false, options);
	return appliesTo(row, ctx.cwd, options) && !liveGrants(options).some((entry) => entry.id === row.id);
}

/** `/trust` with no arguments in a terminal: the decisions, and the next things a user would do with them. */
async function menu(ctx: CommandContext, options: TrustOptions): Promise<void> {
	const rows = liveGrants(options);
	const widen: Array<{ label: string; which: GrantTarget }> = [];
	for (const which of ["parent", "grandparent"] as const) {
		try {
			const folder = grantPath(ctx.cwd, which, options);
			if (!rows.some((row) => row.path === folder && row.scope === "subtree" && row.decision === "trusted"))
				widen.push({ label: `Trust ${shown(folder)} and everything under it`, which });
		} catch {
			// Not offered: the home folder or a filesystem root.
		}
	}
	if (ctx.mode === "tui") return page(ctx, widen, options);
	const entries = new Map(rows.map((row) => [describeGrant(row), row]));
	const close = "Close";
	const choice = await ctx.ui.select(
		`Folder trust \u2014 ${describeFolder(ctx.cwd, resolveFolderTrust(ctx.cwd, options))}\nChoose an entry to remove it, or trust a wider folder.`,
		[...entries.keys(), ...widen.map((entry) => entry.label), close],
	);
	if (choice === undefined || choice === close) return;
	const row = entries.get(choice);
	if (row) return remove(ctx, row, false, options);
	const wider = widen.find((entry) => entry.label === choice);
	if (wider) await add(ctx, { scope: wider.which, yes: false, rest: "" }, options);
}

/** The one `/trust` command: list, add, remove, and a menu. Grants and refusals live in the agent database. */
export function registerTrustCommand(commands: Subcommands, options: TrustOptions = {}): void {
	commands.add("trust", {
		description: "Show, add or remove folder trust",
		argumentHint: "[list|add|remove]",
		complete: (prefix) => wordCompletions(["list", "add", "remove"], prefix),
		handler: async (args, ctx) => {
			const [sub = "", ...words] = args.split(/\s+/).filter(Boolean);
			try {
				if (sub === "") return ctx.hasUI ? await menu(ctx, options) : say(ctx, describeAll(ctx.cwd, options));
				if (sub === "list") return say(ctx, describeAll(ctx.cwd, options));
				const parsed = parse(words);
				if (typeof parsed === "string") return say(ctx, parsed, "warning");
				if (sub === "add") return await add(ctx, parsed, options);
				if (sub === "remove") return await remove(ctx, findEntry(parsed.rest, options), parsed.yes, options);
				say(ctx, USAGE, "warning");
			} catch (error) {
				if (!(error instanceof TrustCommandError)) throw error;
				say(ctx, error.message, "warning");
			}
		},
	});
}

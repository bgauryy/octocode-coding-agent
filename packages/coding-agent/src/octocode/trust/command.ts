import path from "node:path";
import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
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

const surfaceOf = (ctx: ExtensionCommandContext) => (ctx.hasUI ? ("tui" as const) : ("print" as const));

async function add(ctx: ExtensionCommandContext, parsed: Parsed, options: TrustOptions): Promise<void> {
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
		const yes = await ctx.ui.confirm(`Trust ${shown(target)}?`, `${WHAT_TRUST_ALLOWS} Trusts ${reach}.`);
		if (!yes) return say(ctx, "Nothing was changed.");
	}
	const granted = addTrust(folder, parsed.scope, surfaceOf(ctx), options);
	say(ctx, `Trusted ${shown(granted.path)}${granted.scope === "subtree" ? " and everything under it" : ""}.`);
}

/** Asks, then removes. Removing the decision that lets this session run closes the session: the next open asks again. */
async function remove(
	ctx: ExtensionCommandContext,
	row: FolderGrantView,
	yes: boolean,
	options: TrustOptions,
): Promise<void> {
	const closes = appliesTo(row, ctx.cwd, options);
	if (!yes) {
		if (!ctx.hasUI)
			return say(
				ctx,
				"Removing trust needs your confirmation: run octocode trust remove --yes, or /trust in a terminal.",
				"warning",
			);
		const ok = await ctx.ui.confirm(
			`Remove ${row.decision === "refused" ? "the refusal for" : "trust for"} ${shown(row.path)}?`,
			closes
				? "This is the decision that lets this session run. Octocode will close, and ask again the next time you open the folder."
				: "Octocode will ask again the next time you open that folder.",
		);
		if (!ok) return say(ctx, "Nothing was changed.");
	}
	removeTrust(row, options);
	say(
		ctx,
		`Removed ${describeGrant(row)}.${closes ? " Closing: Octocode will ask again the next time you open this folder." : ""}`,
	);
	if (closes) ctx.shutdown();
}

/** `/trust` with no arguments in a terminal: the decisions, and the next things a user would do with them. */
async function menu(ctx: ExtensionCommandContext, options: TrustOptions): Promise<void> {
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

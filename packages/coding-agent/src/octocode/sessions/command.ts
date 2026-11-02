import fs from "node:fs";
import path from "node:path";
import { GLYPH } from "@octocodeai/octocode-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/features/index.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import type { SessionExtras } from "../../core/session-picker.ts";
import { runningPid } from "../agentdb/api.ts";
import { notify, type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { formatCost } from "../shared/format.ts";
import { sessionDir, sessionsRoot } from "../shared/home.ts";
import { contentText } from "../shared/util.ts";
import { shortDuration } from "./brief.ts";
import { listingScope, quickList } from "./catalog.ts";
import { type SessionExtra, type SessionIndex, type SessionLinks, shownLine } from "./store.ts";
import { isWithin, repoKey } from "../shared/home/repo.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** Random tail of a session id (Octocode's UUIDv7 ids share their leading timestamp digits). */
const shortId = (id: string): string => id.replace(/[^\w]/g, "").slice(-6);

/** An item as the backlog shows it. */
const itemRef = (seq: number): string => `B${seq}`;

/** `B12` (any case) as the whole query: the item whose holders `/resume` lists. */
function itemOf(query: string): number | undefined {
	const match = /^b(\d{1,9})$/i.exec(query.trim());
	return match ? Number(match[1]) : undefined;
}

/** A session as listed: Octocode's view of it, with what the extras table adds (cost, branch, files, liveness). */
interface ListedSession {
	info: SessionInfo;
	extra: SessionExtra | undefined;
	/** The backlog items it holds and the team agent it runs as. */
	links?: SessionLinks;
	/** The first message of the session it was forked from. */
	parentPrompt?: string;
}

/** Whether a session's process is running now (this one included). */
const live = ({ extra }: ListedSession): boolean => runningPid(extra?.pid, extra?.pid_started) !== undefined;

function title({ info, parentPrompt }: ListedSession): string {
	// A fork has no prompt of its own until its first new one: show what it was forked from.
	return shownLine(info.name || info.firstMessage || (parentPrompt ? `↳ ${parentPrompt}` : "(no prompt yet)"), 60);
}

/** `● name-or-first-prompt · cwd · branch · 2h ago · ≈$1.84 · 7 files · 12 messages · 3f9a2c`, `(current)` for this session. */
function sessionLine(row: ListedSession, current: string | undefined, all: boolean, now = Date.now()): string {
	const { info, extra } = row;
	const parts = [`${live(row) ? GLYPH.live : GLYPH.pending} ${title(row)}`];
	if (all) parts.push(shownLine(path.basename(info.cwd) || info.cwd || "?", 40));
	if (extra?.branch) parts.push(shownLine(extra.branch, 40));
	parts.push(`${shortDuration(now - info.modified.getTime())} ago`);
	if (extra && (extra.cost > 0 || extra.unpriced === 1))
		parts.push(formatCost({ cost: extra.cost, unpriced: extra.unpriced === 1 }));
	if (extra && extra.files_changed > 0)
		parts.push(`${extra.files_changed} file${extra.files_changed === 1 ? "" : "s"}`);
	if (row.links?.items.length) parts.push(row.links.items.map(itemRef).join(" "));
	if (row.links?.agent) parts.push(shownLine(row.links.agent, 40));
	parts.push(`${info.messageCount} message${info.messageCount === 1 ? "" : "s"}`, shortId(info.id));
	return `${parts.join(" · ")}${info.id === current ? " (current)" : ""}`;
}

function details(row: ListedSession, current: string | undefined): string {
	const { info, extra } = row;
	const at = (date: Date) => date.toISOString().slice(0, 16).replace("T", " ");
	return [
		sessionLine(row, current, true),
		`id: ${info.id}`,
		`file: ${info.path}`,
		`cwd: ${shownLine(info.cwd, 300)}`,
		`started: ${at(info.created)} UTC · last active: ${at(info.modified)} UTC`,
		...(info.parentSessionPath ? [`forked from: ${info.parentSessionPath}`] : []),
		...(info.firstMessage && info.name ? [`first prompt: ${shownLine(info.firstMessage, 300)}`] : []),
		`tokens: ${extra?.tokens ?? 0} · live: ${live(row) ? `yes (pid ${runningPid(extra?.pid, extra?.pid_started)})` : "no"}`,
		`octocode data: ${sessionDir(info.id)}`,
	].join("\n");
}

/** This session as Octocode would list it: it has no file before its first reply (or ever, with --no-session). */
function currentInfo(ctx: ExtensionCommandContext): SessionInfo {
	const manager = ctx.sessionManager;
	const messages = manager.getEntries().filter((entry) => entry.type === "message");
	const first = messages.find((entry) => entry.message.role === "user");
	const header = manager.getHeader();
	return {
		path: manager.getSessionFile() ?? "",
		id: manager.getSessionId(),
		cwd: ctx.cwd,
		...(manager.getSessionName() ? { name: manager.getSessionName() } : {}),
		created: new Date(header?.timestamp ?? Date.now()),
		modified: new Date(),
		messageCount: messages.length,
		firstMessage: first?.type === "message" ? contentText((first.message as { content?: unknown }).content) : "",
		allMessagesText: "",
	};
}

/** Octocode's sessions, newest first, matching `query` (name, messages, id, branch), with their extras. */
async function listSessions(
	ctx: ExtensionCommandContext,
	index: SessionIndex | undefined,
	all: boolean,
	query: string,
	only?: ReadonlySet<string>,
): Promise<ListedSession[]> {
	const { sessionDir } = listingScope(ctx.sessionManager, ctx.cwd, all);
	const infos = all
		? await (sessionDir ? SessionManager.listAll(sessionDir) : SessionManager.listAll())
		: await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
	if (!infos.some((info) => info.id === ctx.sessionManager.getSessionId())) infos.push(currentInfo(ctx));
	const shown = only ? infos.filter((info) => only.has(info.id)) : infos;
	const ids = shown.map((info) => info.id);
	const extras = index?.extras(ids) ?? new Map<string, SessionExtra>();
	const links = index?.links(ids) ?? new Map<string, SessionLinks>();
	const needle = query.toLowerCase();
	const firstByPath = new Map(infos.map((info) => [path.resolve(info.path), info.firstMessage]));
	return shown
		.map((info) => {
			const linked = links.get(info.id);
			return { info, extra: extras.get(info.id), ...(linked ? { links: linked } : {}) };
		})
		.filter(
			({ info, extra }) =>
				!needle ||
				[info.name, info.firstMessage, info.allMessagesText, info.id, extra?.branch].some((text) =>
					text?.toLowerCase().includes(needle),
				),
		)
		.sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime())
		.map((row) => {
			const parentPrompt = row.info.parentSessionPath
				? firstByPath.get(path.resolve(row.info.parentSessionPath))
				: undefined;
			return parentPrompt ? { ...row, parentPrompt } : row;
		});
}

interface SessionsCommandOptions {
	/** The index, or throws when the agent database cannot be opened. */
	index: () => SessionIndex;
	/** The current session id. */
	current: () => string | undefined;
}

/** A row's extras as the picker shows them: what the session table and the backlog and team links say. */
function pickerExtras(extra: SessionExtra | undefined, links: SessionLinks | undefined): SessionExtras {
	return {
		...(extra
			? {
					live: runningPid(extra.pid, extra.pid_started) !== undefined,
					...(extra.branch ? { branch: shownLine(extra.branch, 40) } : {}),
					...(extra.cost > 0 || extra.unpriced === 1
						? { cost: formatCost({ cost: extra.cost, unpriced: extra.unpriced === 1 }) }
						: {}),
					...(extra.files_changed > 0 ? { files: extra.files_changed } : {}),
				}
			: {}),
		...(links?.items.length ? { items: links.items.map(itemRef) } : {}),
		...(links?.agent ? { agent: shownLine(links.agent, 40) } : {}),
	};
}

/** The extras of each of `ids` that has any. */
function pickerExtrasOf(index: SessionIndex | undefined, ids: readonly string[]): Map<string, SessionExtras> {
	const extras = index?.extras(ids) ?? new Map<string, SessionExtra>();
	const links = index?.links(ids) ?? new Map<string, SessionLinks>();
	return new Map(
		ids.flatMap((id) => (extras.has(id) || links.has(id) ? [[id, pickerExtras(extras.get(id), links.get(id))]] : [])),
	);
}

/** Open the host's session picker (interactive mode): Enter resumes, ctrl+r renames, ctrl+o lists the details and forget actions. */
async function pick(
	pickSession: NonNullable<ExtensionCommandContext["ui"]["pickSession"]>,
	ctx: ExtensionCommandContext,
	index: SessionIndex | undefined,
	start: { all: boolean; query: string; current: string | undefined; only?: ReadonlySet<string> },
): Promise<void> {
	const { current } = start;
	const row = (info: SessionInfo): ListedSession => ({ info, extra: index?.get(info.id) });
	const picked = await pickSession({
		initialScope: start.all ? "all" : "current",
		initialQuery: start.query,
		...(start.only ? { onlySessions: start.only } : {}),
		quickList: (scope) =>
			index ? quickList(index, listingScope(ctx.sessionManager, ctx.cwd, scope === "all")) : Promise.resolve([]),
		extras: (ids) => pickerExtrasOf(index, ids),
		actions: [
			{ label: "Details", run: (s) => say(ctx, details(row(s), current)) },
			{ label: "Forget Octocode data", run: (s) => forget(ctx, index, row(s), current) },
		],
	});
	if (picked) await resume(ctx, row(picked), current);
}

/** `/resume [all|<query>]`: the session picker, or a text list without a UI. */
export function registerSessionsCommand(
	_api: ExtensionAPI,
	commands: Subcommands,
	options: SessionsCommandOptions,
): void {
	commands.add("resume", {
		description: "Resume a recent session of this directory",
		argumentHint: "[all] [<query>|B<n>]",
		complete: (prefix) => wordCompletions(["all"], prefix),
		handler: async (args, ctx) => {
			// Without the agent database the list still works; it only lacks cost, branch, files and liveness.
			let index: SessionIndex | undefined;
			try {
				index = options.index();
			} catch {
				index = undefined;
			}
			const words = args.trim().split(/\s+/);
			const all = words[0] === "all";
			const query = (all ? words.slice(1) : words).join(" ");
			const current = options.current();
			// `B12` alone lists the sessions that held or hold that item: the repository's in this folder's list, any in `all`.
			const seq = itemOf(query);
			const only = seq !== undefined && index ? index.heldItem(seq, all ? undefined : repoKey(ctx.cwd).key) : undefined;
			if (seq !== undefined && only?.size === 0)
				return say(ctx, `No session has held ${itemRef(seq)}.${all ? "" : " Try /resume all."}`);
			if (ctx.hasUI && ctx.ui.pickSession)
				return pick(ctx.ui.pickSession, ctx, index, {
					all,
					query: only ? "" : query,
					current,
					...(only ? { only } : {}),
				});
			let rows: ListedSession[];
			try {
				rows = await listSessions(ctx, index, all, only ? "" : query, only);
			} catch (error) {
				return say(ctx, `Octocode could not list its sessions: ${errorMessage(error)}`, "warning");
			}
			const scope = all
				? "all directories"
				: `${shownLine(path.basename(ctx.cwd) || ctx.cwd, 60)}${query ? ` matching "${shownLine(query, 60)}"` : ""}`;
			if (rows.length === 0) return say(ctx, `No saved sessions for ${scope}.${all ? "" : " Try /resume all."}`);
			return say(
				ctx,
				[
					`Sessions (${scope}), newest first:`,
					...rows.map((row) => `${sessionLine(row, current, all)}\n    ${row.info.id}`),
				].join("\n"),
			);
		},
	});
}

async function resume(ctx: ExtensionCommandContext, row: ListedSession, current: string | undefined): Promise<void> {
	if (row.info.id === current) return notify(ctx.ui, "That is the current session.", "info");
	if (
		live(row) &&
		!(await ctx.ui.confirm(
			"Session is running",
			`Another Octocode process (pid ${runningPid(row.extra?.pid, row.extra?.pid_started)}) has this session open. Resume it here as well?`,
		))
	)
		return;
	await ctx.switchSession(row.info.path);
}

/** The folder `forget` may delete: a session's own, strictly inside the sessions folder; undefined for an id that names anything else. */
function forgettableDir(id: string): string | undefined {
	try {
		const dir = sessionDir(id);
		return isWithin(dir, sessionsRoot()) && dir !== sessionsRoot() ? dir : undefined;
	} catch {
		return undefined;
	}
}

async function forget(
	ctx: ExtensionCommandContext,
	index: SessionIndex | undefined,
	row: ListedSession,
	current: string | undefined,
): Promise<void> {
	if (row.info.id === current)
		return notify(ctx.ui, "The current session cannot be forgotten while it runs.", "warning");
	// Its process would keep writing output, logs and checkpoints into the folder, and its extras would come back.
	if (live(row) && row.extra?.pid !== process.pid)
		return notify(
			ctx.ui,
			`That session is open in another Octocode process (pid ${row.extra?.pid}); close it there first.`,
			"warning",
		);
	// Never let a malformed id resolve to the sessions folder itself or outside it: the delete is recursive.
	const dir = forgettableDir(row.info.id);
	if (!dir)
		return notify(ctx.ui, `Refusing to forget "${title(row)}": its id does not name a session folder.`, "warning");
	const ok = await ctx.ui.confirm(
		"Forget Octocode data",
		`Delete Octocode's saved output, bash logs, checkpoints and extras for "${title(row)}"? Octocode's session file stays.`,
	);
	if (!ok) return;
	fs.rmSync(dir, { recursive: true, force: true });
	index?.forget(row.info.id);
	notify(ctx.ui, `Forgot Octocode data for "${title(row)}".`, "info");
}

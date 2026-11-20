import { builtinDescription } from "../../core/slash-commands.ts";
import path from "node:path";
import { GLYPH } from "@octocodeai/octocode-tui";
import type { FeatureSetup, CommandContext } from "../../core/features/index.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import type { SessionExtras } from "../../core/session-picker.ts";
import { liveProcess, sameProcessAsync } from "../shared/process.ts";
import { cancelledText, notify, type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { formatCost } from "../shared/format.ts";
import { currentSessionWorkspace, sessionDir, sessionDirName, sessionsRoot, sessionTempRoot } from "../shared/home.ts";
import { contentText } from "../shared/util.ts";
import { shortDuration } from "./brief.ts";
import { listingScope, quickList } from "./catalog.ts";
import { pickerRemoval, sharedPickerRemoval } from "./delete.ts";
import { checkoutText } from "../../core/worktree-path.ts";
import { type SessionExtra, type SessionIndex, type SessionLinks, shownLine } from "./store.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { agentRunChildren, workspaces } from "../../../../db/src/api.ts";
import { readWorkspaceIdentity } from "../../storage/workspace.ts";
import fs from "node:fs";

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
	/** Child agents it started (directly), from the run history. */
	children?: number;
	/** The first message of the session it was forked from. */
	parentPrompt?: string;
}

/** How many child agents each of `ids` started itself, from the agent run history; sessions with none are absent. */
function childCounts(index: SessionIndex | undefined, ids: readonly string[]): Map<string, number> {
	return index ? agentRunChildren.countBySession(index.agent.db, ids) : new Map();
}

/** Whether a session's process is running now (this one included). */
const live = ({ extra }: ListedSession): boolean => liveProcess(extra?.pid, extra?.pid_started);

function title({ info, parentPrompt }: ListedSession): string {
	// A fork has no prompt of its own until its first new one: show what it was forked from.
	return shownLine(info.name || info.firstMessage || (parentPrompt ? `↳ ${parentPrompt}` : "(no prompt yet)"), 60);
}

/** `● name-or-first-prompt · cwd · branch · 2h ago · ≈$1.84 · 7 files · 12 messages · 3f9a2c`, `(current)` for this session. */
function sessionLine(row: ListedSession, current: string | undefined, all: boolean, now = Date.now()): string {
	const { info, extra } = row;
	const parts = [`${live(row) ? GLYPH.live : GLYPH.pending} ${title(row)}`];
	if (all) parts.push(shownLine(path.basename(info.cwd) || info.cwd || "?", 40));
	const checkout = checkoutText(info.cwd);
	if (extra?.branch) parts.push(shownLine(extra.branch, 40));
	if (checkout && checkout !== "main") parts.push(shownLine(checkout, 40));
	parts.push(`${shortDuration(now - info.modified.getTime())} ago`);
	if (extra && (extra.cost > 0 || extra.unpriced === 1))
		parts.push(formatCost({ cost: extra.cost, unpriced: extra.unpriced === 1 }));
	if (row.children) parts.push(`${row.children} agent${row.children === 1 ? "" : "s"}`);
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
		`tokens: ${extra?.tokens ?? 0} · live: ${live(row) ? `yes (pid ${extra?.pid})` : "no"}`,
		`octocode data: ${sessionDir(info.id, undefined, currentSessionWorkspace() ? info.cwd : undefined)}`,
	].join("\n");
}

/** This session as Octocode would list it: it has no file before its first reply (or ever, with --no-session). */
function currentInfo(ctx: CommandContext): SessionInfo {
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
	ctx: CommandContext,
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
	const counts = childCounts(index, ids);
	const needle = query.toLowerCase();
	const firstByPath = new Map(infos.map((info) => [path.resolve(info.path), info.firstMessage]));
	return shown
		.map((info) => {
			const linked = links.get(info.id);
			const children = counts.get(info.id);
			return {
				info,
				extra: extras.get(info.id),
				...(linked ? { links: linked } : {}),
				...(children ? { children } : {}),
			};
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
function pickerExtras(
	extra: SessionExtra | undefined,
	links: SessionLinks | undefined,
	children: number | undefined,
): SessionExtras {
	return {
		...(children ? { children } : {}),
		...(extra
			? {
					live: liveProcess(extra.pid, extra.pid_started),
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
	const children = childCounts(index, ids);
	return new Map(
		ids.flatMap((id) =>
			extras.has(id) || links.has(id) || children.has(id)
				? [[id, pickerExtras(extras.get(id), links.get(id), children.get(id))]]
				: [],
		),
	);
}

/** Open the host's session picker (interactive mode): Enter resumes, ctrl+r renames, Ctrl+X marks rows and Ctrl+D deletes the marked rows (or the selected one) after one confirmation, ctrl+o lists the details and forget actions. */
async function pick(
	pickSession: NonNullable<CommandContext["ui"]["pickSession"]>,
	ctx: CommandContext,
	index: SessionIndex | undefined,
	start: { all: boolean; query: string; current: string | undefined; only?: ReadonlySet<string> },
): Promise<void> {
	const { current } = start;
	const row = (info: SessionInfo): ListedSession => {
		const children = childCounts(index, [info.id]).get(info.id);
		return { info, extra: index?.get(info.id), ...(children ? { children } : {}) };
	};
	const picked = await pickSession({
		initialScope: start.all ? "all" : "current",
		initialQuery: start.query,
		...(start.only ? { onlySessions: start.only } : {}),
		quickList: (scope) =>
			index ? quickList(index, listingScope(ctx.sessionManager, ctx.cwd, scope === "all")) : Promise.resolve([]),
		extras: (ids) => pickerExtrasOf(index, ids),
		removeSessions: index ? pickerRemoval(index, () => current) : sharedPickerRemoval(() => current),
		actions: [
			{ label: "Details", run: (s) => say(ctx, details(row(s), current)) },
			{ label: "Forget Octocode data", run: (s) => forget(ctx, index, row(s), current) },
		],
	});
	if (picked) await resume(ctx, row(picked), current);
}

/** `/resume [all|<query>]`: the session picker, or a text list without a UI. */
export function registerSessionsCommand(
	_api: FeatureSetup,
	commands: Subcommands,
	options: SessionsCommandOptions,
): void {
	commands.add("resume", {
		description: builtinDescription("resume"),
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
			const only =
				seq !== undefined && index
					? index.heldItem(seq, all ? undefined : registeredWorkspace(ctx.cwd, index.agent).id)
					: undefined;
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

async function resume(ctx: CommandContext, row: ListedSession, current: string | undefined): Promise<void> {
	if (row.info.id === current) return notify(ctx.ui, "That is the current session.", "info");
	if (
		(await sameProcessAsync(row.extra?.pid, row.extra?.pid_started)) &&
		!(await ctx.ui.confirm(
			"Session is running",
			`Another Octocode process (pid ${row.extra?.pid}) has this session open. Resume it here as well?`,
		))
	)
		return notify(ctx.ui, cancelledText("resumed"), "info");
	await ctx.switchSession(row.info.path);
}

/** The folders `forget` may delete: a session's own, strictly inside the workspace's session roots; undefined when its workspace cannot be verified. */
function forgettableDirs(row: ListedSession, index: SessionIndex): string[] | undefined {
	try {
		const name = sessionDirName(row.info.id);
		let cwd: string | undefined;
		if (currentSessionWorkspace()) {
			const workspace = row.extra?.workspace_id ? workspaces.byId(index.agent.db, row.extra.workspace_id) : undefined;
			const marker = workspace && readWorkspaceIdentity(workspace.root);
			if (!workspace || marker?.id !== workspace.id || marker.binding !== workspace.binding) return undefined;
			cwd = workspace.root;
		}
		const roots = new Set([sessionsRoot(undefined, cwd), sessionTempRoot(undefined, cwd)]);
		return [...roots].map((root) => path.join(root, name));
	} catch {
		return undefined;
	}
}

/**
 * Forget Octocode data: the session's folders (output, bash logs, checkpoints) and its extras row. The transcript and its
 * database mirror stay, so the session still lists and can be resumed; `removeSessions` is the path that deletes a session.
 */
async function forget(
	ctx: CommandContext,
	index: SessionIndex | undefined,
	row: ListedSession,
	current: string | undefined,
): Promise<void> {
	if (row.info.id === current)
		return notify(ctx.ui, "The current session cannot be forgotten while it runs.", "warning");
	// Its process would keep writing output, logs and checkpoints into the folder, and its extras would come back.
	if (row.extra?.pid !== process.pid && (await sameProcessAsync(row.extra?.pid, row.extra?.pid_started)))
		return notify(
			ctx.ui,
			`That session is open in another Octocode process (pid ${row.extra?.pid}); close it there first.`,
			"warning",
		);
	// Never let a malformed id resolve to the sessions folder itself or outside it: the delete is recursive.
	const dirs = index && forgettableDirs(row, index);
	if (!index || !dirs)
		return notify(
			ctx.ui,
			`Refusing to forget "${title(row)}": its session folder or workspace could not be verified.`,
			"warning",
		);
	const ok = await ctx.ui.confirm(
		"Forget Octocode data",
		`Delete Octocode's saved output, bash logs, checkpoints and extras (cost, branch, files) for "${title(row)}"? The session file and its transcript index stay; delete the session itself with ctrl+d.`,
	);
	if (!ok) return notify(ctx.ui, cancelledText("forgotten"), "info");
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	index.forget(row.info.id);
	notify(ctx.ui, `Forgot Octocode data for "${title(row)}".`, "info");
}

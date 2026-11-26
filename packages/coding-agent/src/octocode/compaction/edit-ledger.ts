import path from "node:path";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { renderPrompt } from "../../core/prompt-template.ts";
import type { SessionBeforeCompactEvent } from "../../core/features/index.ts";
import { edits, workspaces } from "../../../../db/src/api.ts";
import { workspaceDb } from "../../storage/workspace-database.ts";
import { shellMutation, shellParserReady } from "../permission/shell/mutation.ts";
import { resolveToolPath } from "../shared/home.ts";
import { sessionWorkspace } from "../shared/home/workspace.ts";
import { saveNamedContent } from "../shared/spill.ts";
import { shortHash } from "@octocodeai/octocode-common/atomic-file";
import { shortPath } from "../../utils/display-path.ts";
import { parts } from "./images.ts";

/**
 * The rest of the modified-file ledger (`addFileToolOps` in `register.ts` adds the `file` tool's changes): the files
 * this session's own `bash` calls wrote, by the same parse the edit log records them with (`team/tools/events.ts`), and
 * the files its subagents changed, from the edit log under each subagent's name. Both join `<modified-files>`, and the
 * Recovery section says they are this session's, with how many came through subagents and the file that lists them by
 * subagent, so after the compaction the model does not take its own changes for another process's.
 */

type Ledger = Pick<SessionBeforeCompactEvent["preparation"], "fileOps" | "messagesToSummarize" | "turnPrefixMessages">;

/**
 * Writes which subagent changed which files, named by its content, and returns where, or undefined
 * when it cannot be saved; replaced in tests. The Recovery line names only the counts and this file: every path is in
 * `<modified-files>` already, and a line naming every subagent grew with each one.
 */
type SaveAgentEdits = (text: string) => string | undefined;

const saveAgentEdits: SaveAgentEdits = (text) => {
	const file = saveNamedContent(text, `subagent-edits-${shortHash(text)}.md`);
	return file && shortPath(file);
};

/** A subagent's changes in the summarized span: its name and the absolute paths it changed. */
interface AgentEdits {
	agent: string;
	files: string[];
}

/** Reads the edit log for one agent's changes after `since`; replaced in tests. */
type AgentChanges = (agent: string, since: number) => string[];

/**
 * The absolute paths `agent` changed after `since`, from the edit log of the checkout `cwd` works in (the team's: an
 * isolated subagent's is its parent's, `sessionWorkspace`); none when it cannot be read.
 */
function loggedChanges(cwd: string): AgentChanges {
	let checkout: { id: string; root: string } | undefined;
	return (agent, since) => {
		try {
			const { agent: db, workspace } = workspaceDb(sessionWorkspace(cwd));
			if (!checkout) {
				const root = workspaces.byId(db.db, workspace.id)?.root;
				if (!root) return [];
				checkout = { id: workspace.id, root };
			}
			const { id, root } = checkout;
			return edits
				.changesSince(db.db, id, since - 1, agent)
				.map((row) => path.join(root, ...String(row.path).split("/")));
		} catch {
			// An unreadable log leaves the subagent's changes out; its report still names them.
			return [];
		}
	};
}

const messageTime = (message: unknown): number | undefined =>
	isRecord(message) && typeof message.timestamp === "number" ? message.timestamp : undefined;

/** The paths the `bash` calls of `messages` wrote, by their parse, for calls whose result is not an error. */
async function bashWrites(messages: readonly unknown[], cwd: string): Promise<string[]> {
	const failed = new Set<string>();
	const done = new Set<string>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		(message.isError ? failed : done).add(message.toolCallId);
	}
	const commands: string[] = [];
	for (const message of messages)
		for (const part of parts(message)) {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== "bash" || typeof part.id !== "string") continue;
			const args = isRecord(part.arguments) ? part.arguments : {};
			if (typeof args.command !== "string" || args.type === "powershell") continue;
			if (done.has(part.id) && !failed.has(part.id)) commands.push(args.command);
		}
	if (commands.length === 0) return [];
	await shellParserReady();
	return commands.flatMap((command) => {
		try {
			const found = shellMutation(command);
			const directories = new Set(found.directories);
			return found.writes
				.filter((file) => !directories.has(file) && !file.startsWith("/dev/"))
				.map((file) => resolveToolPath(cwd, file));
		} catch {
			// A command the parse cannot read names no file.
			return [];
		}
	});
}

/**
 * The subagents whose results the messages hold, with when each started: an `agent` tool result's details and a
 * background report's (`octocode-agent-result`).
 */
function subagentsOf(messages: readonly unknown[]): Map<string, number | undefined> {
	const found = new Map<string, number | undefined>();
	for (const message of messages) {
		if (!isRecord(message) || !isRecord(message.details)) continue;
		const agentResult =
			(message.role === "toolResult" && message.toolName === "agent" && typeof message.details.profile === "string") ||
			(message.role === "custom" && message.customType === "octocode-agent-result");
		const id = message.details.id;
		if (!agentResult || typeof id !== "string" || !id) continue;
		// A report says how long the run took: it started that long before the report arrived.
		const reported =
			typeof message.details.durationMs === "number" && typeof message.timestamp === "number"
				? message.timestamp - message.details.durationMs
				: undefined;
		const started = typeof message.details.startedAt === "number" ? message.details.startedAt : reported;
		const known = found.get(id);
		found.set(id, known === undefined ? started : started === undefined ? known : Math.min(known, started));
	}
	return found;
}

/**
 * Adds this session's `bash` writes and its subagents' changes in the summarized messages to the modified-file list
 * (in place), and returns the Recovery line that says whose the listed files are; none when the list is empty.
 */
export async function addLedgerEdits(
	preparation: Ledger,
	cwd: string,
	changes: AgentChanges = loggedChanges(cwd),
	save: SaveAgentEdits = saveAgentEdits,
): Promise<string[]> {
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const { edited, written } = preparation.fileOps;
	const known = new Set([...edited, ...written].map((file) => resolveToolPath(cwd, file)));
	const add = (file: string) => {
		if (known.has(file)) return;
		known.add(file);
		edited.add(file);
	};
	for (const file of await bashWrites(messages, cwd)) add(file);
	const first = messages.map(messageTime).find((time) => time !== undefined) ?? Date.now();
	const agents: AgentEdits[] = [];
	for (const [agent, started] of subagentsOf(messages)) {
		const files = [...new Set(changes(agent, started ?? first))];
		for (const file of files) add(file);
		if (files.length > 0) agents.push({ agent, files });
	}
	if (edited.size + written.size === 0) return [];
	if (agents.length === 0) return [renderPrompt("notices/recovery/modified-files.md", { agents: 0 })];
	const list = agents
		.map(
			({ agent, files }) =>
				`## ${agent} (${files.length})\n${files.map((file) => `- ${relativeTo(cwd, file)}`).join("\n")}`,
		)
		.join("\n\n");
	const count = new Set(agents.flatMap(({ files }) => files)).size;
	return [
		renderPrompt("notices/recovery/modified-files.md", {
			agents: agents.length === 1 ? "1 subagent" : `${agents.length} subagents`,
			files: count === 1 ? "1 file" : `${count} files`,
			list: save(`# Files changed through subagents\n\n${list}\n`) ?? "",
		}),
	];
}

/** `file` relative to `cwd` when it is inside it, else absolute. */
function relativeTo(cwd: string, file: string): string {
	const relative = path.relative(cwd, file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

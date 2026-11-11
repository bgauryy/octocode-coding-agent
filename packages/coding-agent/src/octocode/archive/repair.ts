import fs from "node:fs";
import path from "node:path";
import type { SessionHeader, CompactionEntry } from "../../core/session-manager.ts";
import { type AgentDb, sessions, transcripts, workspaces } from "../../../../db/src/api.ts";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { isWithin } from "../../../../common/src/paths.ts";
import { readWorkspaceIdentity } from "../../storage/workspace.ts";
import { archiveFolder } from "../history/archive.ts";
import { parseRecordHeader } from "../history/archive/record.ts";
import { saveCompaction } from "./summaries.ts";

const READ_CHUNK = 64 * 1024;
const NEWLINE = 10;

/**
 * Bytes a line must hold to parse to a compaction entry: its type value as JSON writes it, or an escape that could
 * spell it. Every other line is skipped without being decoded or parsed, which is most of a transcript's bytes.
 */
const COMPACTION_MARKS = [Buffer.from('"compaction"'), Buffer.from("\\u")];

/** The lines of `block` (whole lines, without the last newline) that hold a compaction mark, in file order. */
function* compactionCandidates(block: Buffer): Generator<string> {
	const starts = new Set<number>();
	for (const mark of COMPACTION_MARKS) {
		for (let at = block.indexOf(mark); at !== -1;) {
			starts.add(at === 0 ? 0 : block.lastIndexOf(NEWLINE, at) + 1);
			const end = block.indexOf(NEWLINE, at);
			if (end === -1) break;
			at = block.indexOf(mark, end);
		}
	}
	for (const start of [...starts].sort((a, b) => a - b)) {
		const end = block.indexOf(NEWLINE, start);
		// A newline byte never occurs inside a multibyte character: a whole line decodes on its own.
		yield block.toString("utf8", start, end === -1 ? block.length : end);
	}
}

/**
 * The header and compaction entries of one transcript, read through the descriptor opened without following a link.
 * Reads go straight through the handle: a stream around a FileHandle can emit an error (an abort, a read failure)
 * while nothing listens, which ends the process, and leaves the handle's release to the stream's own close. Only the
 * header and the lines that can hold a compaction entry are decoded and parsed (`compactionCandidates`). With `from`
 * (a line start an earlier read ended at), only the header and the lines from there on are read. `end` is the offset
 * just past the last newline: where the next read of a growing file resumes.
 */
async function transcriptCompactions(
	file: string,
	signal?: AbortSignal,
	from = 0,
): Promise<{ header: SessionHeader; entries: CompactionEntry[]; end: number } | undefined> {
	signal?.throwIfAborted();
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(
			file,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		if (!(await handle.stat()).isFile()) return undefined;
		let header: SessionHeader | undefined;
		const entries: CompactionEntry[] = [];
		/** False once the first record is not a session header: the file is not a transcript. */
		const block = (bytes: Buffer): boolean => {
			let rest = bytes;
			while (!header) {
				const end = rest.indexOf(NEWLINE);
				const line = rest.toString("utf8", 0, end === -1 ? rest.length : end);
				rest = end === -1 ? Buffer.alloc(0) : rest.subarray(end + 1);
				if (line.trim()) {
					const value = JSON.parse(line) as Record<string, unknown>;
					if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string") return false;
					header = value as unknown as SessionHeader;
				}
				if (end === -1) return true;
			}
			for (const line of compactionCandidates(rest)) {
				if (!line.trim()) continue;
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value.type !== "compaction") continue;
				if (typeof value.id !== "string" || typeof value.summary !== "string" || typeof value.timestamp !== "string")
					throw new Error(`Invalid compaction entry in ${file}`);
				entries.push(value as unknown as CompactionEntry);
			}
			return true;
		};
		// The pieces of the line still being read: joined once, when its newline arrives.
		const pending: Buffer[] = [];
		/** The offset of the next read, and the offset just past the last newline read (where `pending` starts). */
		let position = 0;
		let end = 0;
		for (;;) {
			signal?.throwIfAborted();
			const chunk = Buffer.allocUnsafe(READ_CHUNK);
			const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			const data = chunk.subarray(0, bytesRead);
			const cut = data.lastIndexOf(NEWLINE);
			if (cut === -1) {
				pending.push(data);
				continue;
			}
			const whole = pending.length ? Buffer.concat([...pending, data.subarray(0, cut)]) : data.subarray(0, cut);
			pending.length = 0;
			pending.push(data.subarray(cut + 1));
			end = position - bytesRead + cut + 1;
			if (!block(whole)) return undefined;
			// Once the header is read, a resumed read skips to `from`, the start of a line an earlier read did not reach.
			if (header && end < from) {
				pending.length = 0;
				position = from;
				end = from;
			}
		}
		if (!block(Buffer.concat(pending))) return undefined;
		return header ? { header, entries, end } : undefined;
	} finally {
		await handle.close();
	}
}

interface ExpectedSource {
	workspace: string;
	session?: string;
}

interface Origin {
	ids: Set<string>;
	verified: boolean;
	/** The offset just past the last whole line read. */
	end: number;
}

/** What a repair of one transcript found: its compaction entries, whether their origin is proven, and where it ended. */
interface TranscriptRepair {
	verified: boolean;
	entries: number;
	end: number;
}

/** One recovery batch: parse each transcript once, retain only origin IDs, and refresh on the next operation. */
export class HistoryRepair {
	private readonly sources = new Map<string, Promise<Origin | undefined>>();
	private readonly agent: AgentDb;
	private readonly env: NodeJS.ProcessEnv;
	private readonly signal?: AbortSignal;
	constructor(agent: AgentDb, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
		this.agent = agent;
		this.env = env;
		this.signal = signal;
	}

	/**
	 * Index the compactions of `file`. Resolves, for a transcript repair may use, how many compaction entries it holds and
	 * whether their origin is proven (`verified`); undefined otherwise. With `from` (an earlier result's `end` for the same
	 * file), only the entries after it are read: `entries` counts those.
	 */
	async transcript(file: string, from = 0): Promise<TranscriptRepair | undefined> {
		const origin = await this.visit(file, new Set(), undefined, from);
		return origin && { verified: origin.verified, entries: origin.ids.size, end: origin.end };
	}

	/** Index the compactions of the transcript a session's archive record names; undefined when it names none repair may use. */
	async archive(folder: string): Promise<(TranscriptRepair & { file: string }) | undefined> {
		this.signal?.throwIfAborted();
		const workspace = readWorkspaceIdentity(folder);
		if (!workspace || workspaces.byId(this.agent.db, workspace.id)?.binding !== workspace.binding) return;
		const session = path.basename(path.dirname(folder));
		const expected = archiveFolder(session, this.env, workspace.root);
		const file = path.join(expected, "SESSION.md");
		if (path.resolve(folder) !== expected || canonicalPath(file) !== file) return;
		const content = await fs.promises
			.readFile(file, { encoding: "utf8", signal: this.signal })
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
		const record = parseRecordHeader(content);
		if (!record?.transcript || record.repository !== workspace.id || record.session !== session) return;
		const target = this.allowedTranscript(record.transcript, workspace, session);
		const origin = target ? await this.visit(target, new Set(), { workspace: workspace.id, session }) : undefined;
		return origin && { file: record.transcript, verified: origin.verified, entries: origin.ids.size, end: origin.end };
	}

	private allowedTranscript(
		named: string,
		workspace: NonNullable<ReturnType<typeof readWorkspaceIdentity>>,
		session?: string,
	): string | undefined {
		if (!path.isAbsolute(named) || path.extname(named) !== ".jsonl") return undefined;
		const file = canonicalPath(named);
		const indexed = transcripts.fileOwner(this.agent.db, file);
		if (indexed)
			return indexed.workspace_id === workspace.id && (!session || indexed.id === session) ? file : undefined;
		if (!isWithin(file, workspace.root)) return undefined;
		const containing = readWorkspaceIdentity(path.dirname(file));
		return containing?.id === workspace.id && containing.binding === workspace.binding ? file : undefined;
	}

	private async visit(
		file: string,
		ancestry: ReadonlySet<string>,
		expected?: ExpectedSource,
		from = 0,
	): Promise<Origin | undefined> {
		this.signal?.throwIfAborted();
		const key = canonicalPath(file);
		if (ancestry.has(key) || ancestry.size >= 32) return undefined;
		const cacheKey = JSON.stringify([key, expected?.workspace, expected?.session, from]);
		let pending = this.sources.get(cacheKey);
		if (!pending) {
			pending = this.load(key, new Set([...ancestry, key]), expected, from);
			this.sources.set(cacheKey, pending);
		}
		return pending;
	}

	private async load(
		file: string,
		ancestry: ReadonlySet<string>,
		expected?: ExpectedSource,
		from = 0,
	): Promise<Origin | undefined> {
		const current = await transcriptCompactions(file, this.signal, from);
		if (!current) return undefined;
		const { header, entries, end } = current;
		if (expected?.session && header.id !== expected.session) return undefined;
		// A historical header can name a moved, deleted or replaced checkout. Repair never declares a new workspace there.
		const boundId = sessions.byId(this.agent.db, header.id)?.workspace_id;
		const owner = boundId ? workspaces.byId(this.agent.db, boundId) : undefined;
		const workspace = readWorkspaceIdentity(owner?.root ?? header.cwd);
		if (
			!workspace ||
			(owner && (owner.id !== workspace.id || owner.binding !== workspace.binding)) ||
			(expected && workspace.id !== expected.workspace)
		)
			return undefined;
		if (!this.allowedTranscript(file, workspace, header.id)) return undefined;
		const stamp = transcripts.stamp(this.agent.db, header.id);
		if (stamp && canonicalPath(stamp.file) !== file && fs.existsSync(stamp.file)) return undefined;
		const inherited = transcripts.inheritedCompactions(this.agent.db, header.id);
		// A host-created fork has a saved parent snapshot. Never reopen its historical file path.
		const parentFile =
			!inherited &&
			!header.parentSessionId &&
			header.parentSession &&
			this.allowedTranscript(header.parentSession, workspace);
		const parent = parentFile ? await this.visit(parentFile, ancestry, { workspace: workspace.id }) : undefined;
		const verified = !!inherited || (!header.parentSession && !header.parentSessionId) || parent?.verified === true;
		if (!entries.length) return { ids: new Set(), verified, end };
		const names = await fs.promises
			.readdir(archiveFolder(header.id, this.env, workspace.root))
			.catch((): string[] => []);
		for (const entry of entries) {
			this.signal?.throwIfAborted();
			if (inherited?.has(entry.id) || parent?.ids.has(entry.id)) continue;
			const name = names.find((name) => /^\d+-/.test(name) && name.endsWith(`-${entry.id}.md`));
			saveCompaction(this.agent, workspace.root, header.id, entry, {
				recovered: true,
				env: this.env,
				verified,
				transcript: file,
				detail: name ? { name, n: Number(name.split("-")[0]) } : null,
			});
		}
		return { ids: new Set(entries.map((entry) => entry.id)), verified, end };
	}
}

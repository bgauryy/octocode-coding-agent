import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { SessionHeader, CompactionEntry } from "../../core/session-manager.ts";
import { type AgentDb, sessions, transcripts, workspaces } from "../../../../db/src/api.ts";
import { canonicalPath, isWithin } from "../shared/home/repo.ts";
import { readWorkspaceIdentity } from "../../config/workspace.ts";
import { archiveFolder } from "../shared/archive.ts";
import { parseRecordHeader } from "../shared/archive/record.ts";
import { saveCompaction } from "./summaries.ts";

async function transcriptCompactions(
	file: string,
	signal?: AbortSignal,
): Promise<{ header: SessionHeader; entries: CompactionEntry[] } | undefined> {
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
	const stream = fs.createReadStream(file, { fd: handle, encoding: "utf8", signal, autoClose: false });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let header: SessionHeader | undefined;
	const entries: CompactionEntry[] = [];
	try {
		if (!(await handle.stat()).isFile()) return undefined;
		for await (const line of lines) {
			signal?.throwIfAborted();
			if (!line.trim()) continue;
			const value = JSON.parse(line) as Record<string, unknown>;
			if (!header) {
				if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string") return undefined;
				header = value as unknown as SessionHeader;
			} else if (value.type === "compaction") {
				if (typeof value.id !== "string" || typeof value.summary !== "string" || typeof value.timestamp !== "string")
					throw new Error(`Invalid compaction entry in ${file}`);
				entries.push(value as unknown as CompactionEntry);
			}
		}
		return header ? { header, entries } : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		lines.close();
		stream.destroy();
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

	async transcript(file: string): Promise<void> {
		await this.visit(file, new Set());
	}

	async archive(folder: string): Promise<void> {
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
		if (target) await this.visit(target, new Set(), { workspace: workspace.id, session });
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
	): Promise<Origin | undefined> {
		this.signal?.throwIfAborted();
		const key = canonicalPath(file);
		if (ancestry.has(key) || ancestry.size >= 32) return undefined;
		const cacheKey = JSON.stringify([key, expected?.workspace, expected?.session]);
		let pending = this.sources.get(cacheKey);
		if (!pending) {
			pending = this.load(key, new Set([...ancestry, key]), expected);
			this.sources.set(cacheKey, pending);
		}
		return pending;
	}

	private async load(
		file: string,
		ancestry: ReadonlySet<string>,
		expected?: ExpectedSource,
	): Promise<Origin | undefined> {
		const current = await transcriptCompactions(file, this.signal);
		if (!current) return undefined;
		const { header, entries } = current;
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
		if (!entries.length) return { ids: new Set(), verified };
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
		return { ids: new Set(entries.map((entry) => entry.id)), verified };
	}
}

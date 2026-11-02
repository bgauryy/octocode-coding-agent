import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { SessionHeader, CompactionEntry } from "../../core/session-manager.ts";
import type { AgentDb } from "../agentdb/api.ts";
import { archiveFolder } from "../shared/archive.ts";
import { parseRecordHeader } from "../shared/archive/record.ts";
import { sessionWorkspace } from "../shared/home/workspace.ts";
import { saveCompaction } from "./summaries.ts";

async function transcriptCompactions(
	file: string,
	signal?: AbortSignal,
): Promise<{ header: SessionHeader; entries: CompactionEntry[] } | undefined> {
	const stream = fs.createReadStream(file, { encoding: "utf8", signal });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let header: SessionHeader | undefined;
	const entries: CompactionEntry[] = [];
	try {
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
	}
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
		const content = await fs.promises
			.readFile(path.join(folder, "SESSION.md"), { encoding: "utf8", signal: this.signal })
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
		const transcript = content ? parseRecordHeader(content)?.transcript : undefined;
		if (transcript) await this.transcript(transcript);
	}

	private async visit(file: string, ancestry: ReadonlySet<string>): Promise<Origin | undefined> {
		this.signal?.throwIfAborted();
		const key = path.resolve(file);
		if (ancestry.has(key) || ancestry.size >= 32) return undefined;
		let pending = this.sources.get(key);
		if (!pending) {
			pending = this.load(key, new Set([...ancestry, key]));
			this.sources.set(key, pending);
		}
		return pending;
	}

	private async load(file: string, ancestry: ReadonlySet<string>): Promise<Origin | undefined> {
		const current = await transcriptCompactions(file, this.signal);
		if (!current) return undefined;
		const { header, entries } = current;
		const parent = header.parentSession ? await this.visit(header.parentSession, ancestry) : undefined;
		const verified = !header.parentSession || parent?.verified === true;
		const workspace = sessionWorkspace(header.cwd, {});
		const names = await fs.promises.readdir(archiveFolder(header.id, this.env)).catch((): string[] => []);
		for (const entry of entries) {
			this.signal?.throwIfAborted();
			if (parent?.ids.has(entry.id)) continue;
			const name = names.find((name) => /^\d+-/.test(name) && name.endsWith(`-${entry.id}.md`));
			saveCompaction(this.agent, workspace, header.id, entry, {
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

import fs from "node:fs";
import path from "node:path";
import { recordedLocalReads } from "../../shared/local-reads.ts";
import { OCTOCODE_DIR, readPaths, workspaceScratchDir } from "../../shared/home.ts";
import { processStartTime, sameProcess } from "../../shared/process.ts";
import { cleanupDays } from "../../shared/env.ts";
import { DAY_MS } from "../../shared/util.ts";
import { canonicalPath } from "../../shared/home/repo.ts";
import { teamWorkspace } from "../../team/store/workspace.ts";
import type { ReportArtifact } from "../../shared/report-artifact.ts";

/**
 * `<team workspace>/.octocode/tmp/agents`: one folder per subagent for the files it hands back. The team workspace
 * (`teamWorkspace`, which follows `OCTOCODE_TEAM_WORKSPACE`) is where `agentScratch` writes, so names and the sweep see
 * the same folders.
 */
export const scratchRoot = (cwd: string, env: NodeJS.ProcessEnv = process.env) =>
	path.join(teamWorkspace(cwd, env), OCTOCODE_DIR, "tmp", "agents");

/**
 * Names whose scratch folder exists. A name is a subagent's identity: its scratch folder holds its saved conversation
 * (`session/`), which Octocode reopens for the same session id. A new subagent must not take one of these names, or it would
 * continue another agent's conversation; the folder is kept (it is that agent's evidence) until the sweep removes it.
 */
export function scratchNames(cwd: string): string[] {
	try {
		return fs.readdirSync(scratchRoot(cwd));
	} catch {
		return [];
	}
}

/** File in a scratch folder naming the Octocode process that started the subagent: its pid, then its start time (so a reused pid is not mistaken for it). */
const OWNER_FILE = ".owner";

/**
 * The subagent's handoff folder, or undefined when the workspace is not writable (it then reports inline only). It
 * names this process as its owner, so another session's sweep leaves it alone while this process runs.
 */
export function agentScratch(cwd: string, id: string): string | undefined {
	try {
		const dir = workspaceScratchDir(teamWorkspace(cwd), path.join("agents", id));
		fs.writeFileSync(
			path.join(dir, OWNER_FILE),
			[process.pid, processStartTime(process.pid)].filter(Boolean).join(" "),
		);
		return dir;
	} catch {
		return undefined;
	}
}

/** Whether the process that owns a scratch folder still runs. An owner file with only a pid (start time unknown) is judged by the pid. */
function ownerRunning(dir: string): boolean {
	try {
		const [pid, ...started] = fs.readFileSync(path.join(dir, OWNER_FILE), "utf8").trim().split(" ");
		return sameProcess(Number(pid), started.join(" "));
	} catch {
		return false;
	}
}

/**
 * Newest write in a scratch folder: the folder, its saved conversation (`session/` and every file in it: appends to a
 * transcript do not touch the folder) and its report. 0 when it is missing.
 */
async function lastWrite(dir: string): Promise<number> {
	const session = path.join(dir, "session");
	const transcripts = await fs.promises.readdir(session).catch((): string[] => []);
	const files = [dir, session, path.join(dir, "report.md"), ...transcripts.map((name) => path.join(session, name))];
	const times = await Promise.all(
		files.map((file) =>
			fs.promises.stat(file).then(
				(stat) => stat.mtimeMs,
				() => 0,
			),
		),
	);
	return Math.max(0, ...times);
}

/**
 * Removes scratch folders nothing wrote to for `OCTOCODE_CLEANUP_DAYS` (default 30; `0` keeps them), except those whose
 * owning Octocode process (this or another session) is alive. Never rejects.
 */
export async function sweepScratch(
	root: string,
	env: NodeJS.ProcessEnv = process.env,
	now = Date.now(),
): Promise<void> {
	const days = cleanupDays(env);
	if (days === 0) return;
	let names: string[];
	try {
		names = await fs.promises.readdir(root);
	} catch {
		return;
	}
	for (const name of names) {
		const dir = path.join(root, name);
		if (ownerRunning(dir)) continue;
		try {
			if (now - (await lastWrite(dir)) > days * DAY_MS) await fs.promises.rm(dir, { recursive: true, force: true });
		} catch {
			// Removed meanwhile, or not ours to remove.
		}
	}
}

/**
 * Report files the parent has read through local fetch or a legacy reader, by agent id, with the time.
 * A report whose file was read after its last change reaches the parent without starting a turn.
 */
export class ReadReports {
	private readonly scratch = new Map<string, string>();
	private readonly readAt = new Map<string, { at: number; sha256?: string }>();

	track(id: string, scratch: string | undefined): void {
		if (scratch) this.scratch.set(canonicalPath(path.join(path.resolve(scratch), "report.md")), id);
	}

	observe(toolName: string, input: Record<string, unknown>, cwd: string, details?: unknown): void {
		const reads = [
			...readPaths(toolName, input, cwd).map((file) => ({ file, sha256: undefined })),
			...recordedLocalReads(details),
		];
		for (const read of reads) {
			const file = canonicalPath(read.file);
			const canonical = path.join(path.dirname(file), "report.md");
			if (this.scratch.has(canonical) && /^report(?:-[a-f0-9]{64})?\.md$/.test(path.basename(file)))
				this.readAt.set(file, { at: Date.now(), sha256: read.sha256 });
		}
	}

	/** Whether the parent read this agent's report file since it was last written; forgets the agent. */
	consume(id: string, artifact?: ReportArtifact): boolean {
		const file = [...this.scratch].find(([, owner]) => owner === id)?.[0];
		if (!file) return false;
		const version = artifact?.path ? this.readAt.get(canonicalPath(artifact.path)) : undefined;
		const canonical = this.readAt.get(file);
		this.scratch.delete(file);
		for (const read of this.readAt.keys()) if (path.dirname(read) === path.dirname(file)) this.readAt.delete(read);
		// A digest-bound completion is acknowledged only by a read of this version, never a predecessor's mtime.
		if (artifact)
			return Boolean(artifact.path && (version?.sha256 === artifact.sha256 || canonical?.sha256 === artifact.sha256));
		if (!canonical) return false;
		try {
			return fs.statSync(file).mtimeMs <= canonical.at;
		} catch {
			return false;
		}
	}
}

/** Removes a scratch folder the subagent left empty (only the owner marker), so finished runs leave no clutter. */
export function dropEmptyScratch(dir: string | undefined): boolean {
	if (!dir) return false;
	try {
		if (fs.readdirSync(dir).some((name) => name !== OWNER_FILE)) return false;
		fs.rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

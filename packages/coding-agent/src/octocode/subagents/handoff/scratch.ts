import fs from "node:fs";
import path from "node:path";
import { recordedLocalReads } from "../../shared/local-reads.ts";
import { readPaths, workspacePaths, workspaceScratchDir } from "../../shared/home.ts";
import { processStartTime, sameProcess } from "../../shared/process.ts";
import { sweepStaleOutputs } from "../../shared/sweep.ts";
import { DAY_MS } from "../../shared/util.ts";
import { canonicalPath } from "../../shared/home/repo.ts";
import { teamWorkspace } from "../../team/store/workspace.ts";

/** Subagent scratch folders untouched this long are removed when a session starts. */
const SCRATCH_MAX_AGE_MS = 7 * DAY_MS;

/** `<workspace>/.octocode/tmp/agents`: one folder per subagent for the files it hands back. */
export const scratchRoot = (cwd: string) => path.join(workspacePaths(cwd).tmp, "agents");

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

/** Removes scratch folders untouched for a week, except those whose owning Octocode process (this or another session) is alive. */
export async function sweepScratch(root: string): Promise<void> {
	let names: string[];
	try {
		names = await fs.promises.readdir(root);
	} catch {
		return;
	}
	const owned = new Set(names.filter((name) => ownerRunning(path.join(root, name))));
	await sweepStaleOutputs(root, SCRATCH_MAX_AGE_MS, owned);
}

/**
 * Report files the parent has read through local fetch or a legacy reader, by agent id, with the time.
 * A report whose file was read after its last change reaches the parent without starting a turn.
 */
export class ReadReports {
	private readonly scratch = new Map<string, string>();
	private readonly readAt = new Map<string, number>();

	track(id: string, scratch: string | undefined): void {
		if (scratch) this.scratch.set(canonicalPath(path.join(path.resolve(scratch), "report.md")), id);
	}

	observe(toolName: string, input: Record<string, unknown>, cwd: string, details?: unknown): void {
		for (const file of [...readPaths(toolName, input, cwd), ...recordedLocalReads(details).map((read) => read.file)]) {
			const id = this.scratch.get(canonicalPath(file));
			if (id) this.readAt.set(id, Date.now());
		}
	}

	/** Whether the parent read this agent's report file since it was last written; forgets the agent. */
	consume(id: string): boolean {
		const at = this.readAt.get(id);
		const file = [...this.scratch].find(([, owner]) => owner === id)?.[0];
		this.readAt.delete(id);
		if (file) this.scratch.delete(file);
		if (at === undefined || !file) return false;
		try {
			return fs.statSync(file).mtimeMs <= at;
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

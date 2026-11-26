import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type ProcessRow, readProcessTable } from "../processes/table.ts";
import { canonical, worktreesFolder } from "./repo.ts";

/** Another vendor's agent CLI running on this machine: it cannot receive `message`. */
export interface ForeignCli {
	pid: number;
	/** Product name, as the user knows it. */
	name: string;
	/** Its working directory, used to place it in a worktree. */
	cwd: string;
}

/** What the scan reads from the operating system; tests pass their own. */
export interface ForeignCliSources {
	table?: () => Promise<ProcessRow[] | undefined>;
	cwdOf?: (pids: readonly number[]) => Promise<Map<number, string>>;
	/** Processes whose descendants are Octocode's own runs (this process, team members): never listed. */
	ownRoots?: readonly number[];
}

/** The executable at the start of a command line or a script a runtime runs, matched case-sensitively. */
const CLIS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
	{ name: "Claude Code", pattern: /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code\// },
	{ name: "Codex", pattern: /(^|\/)codex(\s|$)|@openai\/codex\// },
	{ name: "Cursor agent", pattern: /(^|\/)cursor-agent(\s|$)/ },
	{ name: "Gemini CLI", pattern: /(^|\/)gemini(\s|$)|@google\/gemini-cli\// },
	{ name: "opencode", pattern: /(^|\/)opencode(\s|$)/ },
	{ name: "Aider", pattern: /(^|\/)aider(\s|$)/ },
];

/** Helper modes of those binaries that are not an agent session. */
const HELPER = /\s--chrome-native-host(\s|$)|\smcp(-server)?(\s|$)/;

const cliName = (command: string): string | undefined =>
	HELPER.test(command) ? undefined : CLIS.find((cli) => cli.pattern.test(command))?.name;

/**
 * The agent CLI processes of the table: one row per session (a wrapper and the binary it starts are one), leaving out
 * any that descend from `ownRoots`, which Octocode itself runs.
 */
export function foreignCliRows(
	rows: readonly ProcessRow[],
	ownRoots: readonly number[],
): Array<ProcessRow & { name: string }> {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const own = new Set(ownRoots);
	const descendsFromOwn = (row: ProcessRow): boolean => {
		const seen = new Set<number>();
		for (let at: ProcessRow | undefined = row; at && !seen.has(at.pid); at = byPid.get(at.ppid)) {
			if (own.has(at.pid)) return true;
			seen.add(at.pid);
		}
		return false;
	};
	return rows.flatMap((row) => {
		const name = cliName(row.command);
		if (!name || descendsFromOwn(row)) return [];
		const parent = byPid.get(row.ppid);
		return parent && cliName(parent.command) === name ? [] : [{ ...row, name }];
	});
}

const run = promisify(execFile);

/** Working directories by pid: `/proc` on Linux, one `lsof` call elsewhere; a pid it cannot read is left out. */
async function readCwds(pids: readonly number[]): Promise<Map<number, string>> {
	const found = new Map<number, string>();
	if (pids.length === 0 || process.platform === "win32") return found;
	if (process.platform === "linux") {
		for (const pid of pids) {
			const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
			if (cwd) found.set(pid, cwd);
		}
		return found;
	}
	// lsof exits 1 when one of the pids is gone; what it printed for the rest still counts.
	const output = await run("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
		encoding: "utf8",
		timeout: 5000,
	})
		.then(({ stdout }) => stdout)
		.catch((error: { stdout?: unknown }) => (typeof error.stdout === "string" ? error.stdout : ""));
	let pid: number | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid !== undefined) found.set(pid, line.slice(1));
	}
	return found;
}

/** Other vendors' agent CLIs running on this machine, with their working directories; empty where `ps` is unavailable. */
export async function foreignClis(sources: ForeignCliSources = {}): Promise<ForeignCli[]> {
	const rows = (await (sources.table ?? readProcessTable)()) ?? [];
	const clis = foreignCliRows(rows, sources.ownRoots ?? [process.pid]);
	const cwds = await (sources.cwdOf ?? readCwds)(clis.map((cli) => cli.pid));
	return clis.flatMap(({ pid, name }) => {
		const cwd = cwds.get(pid);
		return cwd ? [{ pid, name, cwd }] : [];
	});
}

/** How long a scan of the process table stays good for the permission gate, which asks before each discarding command. */
const SCAN_TTL_MS = 5000;

/**
 * A lookup of the other vendor's agent CLI working in a checkout, for a gate that runs before each command: the
 * process scan behind it is shared for a few seconds. Folders under the checkout's worktrees folder belong to their own
 * worktree, not to this checkout.
 */
export function foreignCliInCheckout(
	sources: ForeignCliSources = {},
	now: () => number = Date.now,
): (checkout: string) => Promise<ForeignCli | undefined> {
	let scan: { at: number; clis: Promise<ForeignCli[]> } | undefined;
	return async (checkout) => {
		if (!scan || now() - scan.at > SCAN_TTL_MS) scan = { at: now(), clis: foreignClis(sources) };
		const root = canonical(checkout);
		const worktrees = worktreesFolder(root);
		const inside = (folder: string, parent: string) => {
			const rel = path.relative(parent, canonical(folder));
			return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
		};
		return (await scan.clis).find((cli) => inside(cli.cwd, root) && !inside(cli.cwd, worktrees));
	};
}

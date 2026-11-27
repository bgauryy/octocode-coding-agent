import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";
import { lockSyncWithRetry } from "@octocodeai/octocode-common/file-write-lock";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { getAgentDir } from "../config.ts";

/** A background problem that had no reader when it happened (a headless run's failed index write). */
export interface ProblemRecord {
	timestamp: string;
	/** The feature that failed, such as `sessions`. */
	source: string;
	message: string;
}

const MAX_PROBLEMS = 50;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function problemLogPath(agentDir = getAgentDir()): string {
	return join(agentDir, "problems.json");
}

function isProblemRecord(value: unknown): value is ProblemRecord {
	return isRecord(value) && typeof value.timestamp === "string" && typeof value.message === "string";
}

function load(path: string): { records: ProblemRecord[]; problem?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
		return { records: [], problem: errorMessage(error) };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) return { records: [], problem: "not a JSON array" };
		return { records: parsed.filter(isProblemRecord) };
	} catch (error) {
		return { records: [], problem: errorMessage(error) };
	}
}

/** The recorded problems of the last seven days, oldest first. An unreadable file shows as a problem saying so. */
export function readProblems(path = problemLogPath(), now = Date.now()): ProblemRecord[] {
	const { records, problem } = load(path);
	const recent = records.filter((record) => now - Date.parse(record.timestamp) <= MAX_AGE);
	if (!problem) return recent;
	return [
		...recent,
		{ timestamp: new Date(now).toISOString(), source: "problems", message: `${path} could not be read (${problem})` },
	];
}

/**
 * Append a problem under a cross-process lock, keeping the newest 50 within seven days. Never throws: recording
 * runs inside failure handlers. Returns false, after naming the cause on stderr, when the file cannot be written.
 */
export function recordProblem(source: string, error: unknown, path = problemLogPath(), now = Date.now()): boolean {
	try {
		const record: ProblemRecord = {
			timestamp: new Date(now).toISOString(),
			source,
			// An error can quote a credential; the file may be attached to a bug report.
			message: redactSecrets(errorMessage(error)),
		};
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const release = lockSyncWithRetry(path, { lockfilePath: `${path}.lock` });
		try {
			const kept = load(path).records.filter((entry) => now - Date.parse(entry.timestamp) <= MAX_AGE);
			atomicWriteFileSync(path, `${JSON.stringify([...kept, record].slice(-MAX_PROBLEMS), null, 2)}\n`, {
				mode: PRIVATE_FILE_MODE,
			});
		} finally {
			release();
		}
		return true;
	} catch (writeError) {
		try {
			process.stderr.write(`Octocode problem log unavailable: ${errorMessage(writeError)}\n`);
		} catch {
			// stderr is closed: nothing is left to report to.
		}
		return false;
	}
}

/** The `/status` lines for the recorded problems, empty when there are none. */
export function problemLines(problems: readonly ProblemRecord[]): string[] {
	if (problems.length === 0) return [];
	return [
		`Recent problems (${problems.length})`,
		...problems.slice(-10).map((problem) => `  ${problem.timestamp} ${problem.source}: ${problem.message}`),
		...(problems.length > 10 ? [`  … ${problems.length - 10} older`] : []),
	];
}

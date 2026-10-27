import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { atomicWriteFileSync } from "../utils/atomic-file.ts";
import { lockSyncWithRetry } from "../utils/file-write-lock.ts";
import { projectMcpConfigPaths } from "../../../mcp/src/paths.ts";
import { errorMessage } from "../utils/guards.ts";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

type TrustFile = Record<string, boolean | null | undefined>;

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"mcp.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const value = data[currentDir];
		if (value === true || value === false) {
			return { path: currentDir, decision: value };
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

function getProjectTrustParentPath(cwd: string): string | undefined {
	const trustPath = normalizeCwd(cwd);
	const parentDir = dirname(trustPath);
	return parentDir === trustPath ? undefined : parentDir;
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	const trustPath = normalizeCwd(cwd);
	const trustOptions: ProjectTrustOption[] = [
		{ label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	const parentPath = getProjectTrustParentPath(cwd);
	if (parentPath !== undefined) {
		trustOptions.push({
			label: `Trust parent folder (${parentPath})`,
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			savedPath: parentPath,
		});
	}
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] });
	}
	trustOptions.push({
		label: "Do not trust",
		trusted: false,
		updates: [{ path: trustPath, decision: false }],
		savedPath: trustPath,
	});
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
	}
	return trustOptions;
}

function readTrustFile(path: string): TrustFile {
	return readTrustFileEntries(path).data;
}

/**
 * Earlier builds also wrote the native extension's fingerprinted `{ sha, trusted }` decisions into this file. Each one
 * approved specific hook, agent and skill files, not the project, so it is no core decision: it is returned apart and
 * written back unchanged, for the native store (`pi-trust.json`) to migrate.
 */
function readTrustFileEntries(path: string): { data: TrustFile; legacy: Record<string, unknown> } {
	if (!existsSync(path)) {
		return { data: {}, legacy: {} };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf-8")));
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	const legacy: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (isLegacyFingerprintEntry(value)) {
			legacy[key] = value;
			continue;
		}
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return { data, legacy };
}

function isLegacyFingerprintEntry(value: unknown): value is { sha: string; trusted: boolean } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { sha?: unknown }).sha === "string" &&
		typeof (value as { trusted?: unknown }).trusted === "boolean"
	);
}

function writeTrustFile(path: string, data: TrustFile, legacy: Record<string, unknown> = {}): void {
	const sorted: Record<string, unknown> = {};
	for (const key of [...new Set([...Object.keys(data), ...Object.keys(legacy)])].sort()) {
		const value = data[key];
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		} else if (key in legacy) {
			sorted[key] = legacy[key];
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Writers wait up to about two seconds for a peer (many processes can start at once); readers never lock. */
const TRUST_LOCK_ATTEMPTS = 100;

function acquireTrustLockSync(path: string): () => void {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	return lockSyncWithRetry(trustDir, { lockfilePath: `${path}.lock`, attempts: TRUST_LOCK_ATTEMPTS });
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireTrustLockSync(path);
	try {
		return fn();
	} finally {
		release();
	}
}

/**
 * Returns true when cwd has project-local resources that must be gated by
 * project trust: trust-requiring entries under cwd/.pi, or .agents/skills in
 * cwd or one of its ancestors. Returns false when no such project resources
 * exist. The user/global ~/.agents/skills directory is always treated as a
 * trusted user resource and is ignored here, even when cwd is $HOME.
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
	let currentDir = canonicalizePath(resolvePath(cwd));

	const configDir = join(currentDir, CONFIG_DIR_NAME);
	if (projectMcpConfigPaths(currentDir).some((file) => existsSync(file))) return true;
	if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) {
		return true;
	}

	while (true) {
		const agentsSkillsDir = join(currentDir, ".agents", "skills");
		if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
			return true;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

/** Store problems already reported in this process (one warning per problem, however many stores read it). */
const warnedMessages = new Set<string>();

export class ProjectTrustStore {
	private trustPath: string;
	private readonly onWarning: (message: string) => void;

	/** `onWarning` receives a store problem that was treated as "no decision"; the default prints it once to stderr. */
	constructor(agentDir: string, onWarning?: (message: string) => void) {
		this.onWarning = onWarning ?? ((message) => process.stderr.write(`${message}\n`));
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	get(cwd: string): ProjectTrustDecision {
		return this.getEntry(cwd)?.decision ?? null;
	}

	/**
	 * Writers replace the file by atomic rename, so a read needs no lock: it sees the old or the new content. An
	 * unreadable or invalid store is "no decision" (never trust) with a warning, so startup does not fail on it.
	 */
	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		try {
			return findNearestTrustEntry(readTrustFile(this.trustPath), cwd);
		} catch (error) {
			this.warnOnce(`${errorMessage(error)}. Treating ${cwd} as having no saved trust decision.`);
			return null;
		}
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		this.setMany([{ path: cwd, decision }]);
	}

	setMany(decisions: ProjectTrustUpdate[]): void {
		withTrustFileLock(this.trustPath, () => {
			const { data, legacy } = this.readForWrite();
			for (const { path, decision } of decisions) {
				const key = normalizeCwd(path);
				if (decision === null) {
					delete data[key];
				} else {
					data[key] = decision;
				}
			}
			writeTrustFile(this.trustPath, data, legacy);
		});
	}

	/** A corrupt store would block every later decision: keep it as `trust.json.bak` and start empty. */
	private readForWrite(): ReturnType<typeof readTrustFileEntries> {
		try {
			return readTrustFileEntries(this.trustPath);
		} catch (error) {
			const backup = `${this.trustPath}.bak`;
			copyFileSync(this.trustPath, backup);
			this.warnOnce(`${errorMessage(error)}. Saved a copy as ${backup} and started a new trust store.`);
			return { data: {}, legacy: {} };
		}
	}

	private warnOnce(message: string): void {
		if (warnedMessages.has(message)) return;
		warnedMessages.add(message);
		this.onWarning(message);
	}
}

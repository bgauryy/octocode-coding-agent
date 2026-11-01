import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hostPaths } from "../host.ts";
import type { GeneratedMeta } from "./types.ts";

/**
 * Folder for generated files under an agent directory: `context-optimization/mcp/`. The folder earlier releases used,
 * `mcp-generated/`, moves there the first time, so its stored overrides keep applying.
 */
export function generatedDir(agentDir: string): string {
	const dir = join(hostPaths().contextOptimizationDir(agentDir), "mcp");
	const legacy = join(agentDir, "mcp-generated");
	if (!existsSync(dir) && existsSync(legacy)) {
		try {
			mkdirSync(hostPaths().contextOptimizationDir(agentDir), { recursive: true });
			renameSync(legacy, dir);
		} catch {
			// Another process moved it first, or the move is not allowed; the files are rendered again when missing.
		}
	}
	return dir;
}

/**
 * The folder of one server's generated file: the project's (`contextOptimizationDirs`) for a server that the
 * workspace `mcp.json` of `cwd` defines, else the user's (`generatedDir`), so two projects that define a same-named
 * server keep separate files and overrides.
 */
export function serverGeneratedDir(agentDir: string, cwd: string, scope: string | undefined): string {
	const project = scope === "project" ? hostPaths().contextOptimizationDirs(cwd, agentDir).project : undefined;
	return project ? join(project.dir, "mcp") : generatedDir(agentDir);
}

/** File-safe stem for a server name. */
function fileStem(server: string): string {
	return server.replace(/[^\w.-]/g, "_");
}

function readSnapshot(dir: string, server: string): (GeneratedMeta & { text?: string }) | undefined {
	try {
		const stem = join(dir, fileStem(server));
		const meta = JSON.parse(readFileSync(`${stem}.json`, "utf8")) as GeneratedMeta & { text?: string };
		if (typeof meta?.hash !== "string" || typeof meta.generatorVersion !== "number") return undefined;
		return meta;
	} catch {
		return undefined;
	}
}

/** Metadata also survives older split caches, whose text cannot be trusted as a matching snapshot. */
export function readGeneratedMeta(dir: string, server: string): GeneratedMeta | undefined {
	const snapshot = readSnapshot(dir, server);
	if (!snapshot) return undefined;
	const { text: _text, ...meta } = snapshot;
	return meta;
}

/** Read one atomic snapshot; the text mirror is for inspection only. Legacy metadata is carried during regeneration. */
export function readGenerated(dir: string, server: string): { text: string; meta: GeneratedMeta } | undefined {
	const snapshot = readSnapshot(dir, server);
	if (typeof snapshot?.text !== "string") return undefined;
	const { text, ...meta } = snapshot;
	return { text, meta };
}

function writeAtomic(file: string, content: string): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, "utf8");
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** Publish text and metadata together in JSON. The `.txt` mirror remains available for human inspection. */
export function writeGenerated(dir: string, server: string, text: string, meta: GeneratedMeta): void {
	mkdirSync(dir, { recursive: true });
	const stem = join(dir, fileStem(server));
	writeAtomic(`${stem}.txt`, text);
	writeAtomic(`${stem}.json`, `${JSON.stringify({ ...meta, text }, null, "\t")}\n`);
}

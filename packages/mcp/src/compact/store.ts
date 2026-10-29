import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { GeneratedMeta } from "./types.ts";

/** Folder for generated files under an agent directory. */
export function generatedDir(agentDir: string): string {
	return join(agentDir, "mcp-generated");
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

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { hostPaths } from "../host.ts";
import type { GeneratedMeta } from "./types.ts";

/** Folder for generated files under an agent directory: `context-optimization/mcp/`. */
export function generatedDir(agentDir: string): string {
	return join(hostPaths().contextOptimizationDir(agentDir), "mcp");
}

/**
 * The folder of one server's generated file: the project's (`contextOptimizationDirs`) for a server that the
 * workspace `mcp.json` of `cwd` defines, else the user's (`generatedDir`), so two projects that define a same-named
 * server keep separate files.
 */
export function serverGeneratedDir(agentDir: string, cwd: string, scope: string | undefined): string {
	const project = scope === "project" ? hostPaths().contextOptimizationDirs(cwd, agentDir).project : undefined;
	return project ? join(project.dir, "mcp") : generatedDir(agentDir);
}

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

/** Read one atomic snapshot; the text mirror is for inspection only.  */
export function readGenerated(dir: string, server: string): { text: string; meta: GeneratedMeta } | undefined {
	const snapshot = readSnapshot(dir, server);
	if (typeof snapshot?.text !== "string") return undefined;
	const { text, ...meta } = snapshot;
	return { text, meta };
}

/** Publish text and metadata together in JSON. The `.txt` mirror remains available for human inspection. */
export function writeGenerated(dir: string, server: string, text: string, meta: GeneratedMeta): void {
	mkdirSync(dir, { recursive: true });
	const stem = join(dir, fileStem(server));
	atomicWriteFileSync(`${stem}.txt`, text);
	atomicWriteFileSync(`${stem}.json`, `${JSON.stringify({ ...meta, text }, null, "\t")}\n`);
}

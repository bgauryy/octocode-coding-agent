import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { isRecord } from "../../utils/guards.ts";

/** One graph tool's contract as the CLI prints it. */
export interface GraphSchema {
	inputSchema: Record<string, unknown>;
	description: string;
}

/**
 * The CLI's schemas on disk, so a process start does not spawn the binary for them. The file holds the schemas of one
 * binary and is valid only for that binary's stamp (`path:size:mtimeMs`): a new build changes the stamp and the next
 * start fetches and stores the schemas again. A missing, unreadable or malformed file is a miss, never an error.
 */

export function defaultSchemaCacheFile(): string {
	return join(getAgentDir(), "cache", "graph-schemas.json");
}

function isGraphSchema(value: unknown): value is GraphSchema {
	return isRecord(value) && isRecord(value.inputSchema) && typeof value.description === "string";
}

export function readSchemaCache(file: string, stamp: string): Record<string, GraphSchema> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isRecord(parsed) || parsed.stamp !== stamp || !isRecord(parsed.schemas)) return undefined;
		const schemas: Record<string, GraphSchema> = {};
		for (const [name, schema] of Object.entries(parsed.schemas)) {
			if (isGraphSchema(schema)) schemas[name] = schema;
		}
		return schemas;
	} catch {
		return undefined;
	}
}

/** Stores the schemas through a temporary file and a rename, so a concurrent reader never sees half a file. */
export function writeSchemaCache(file: string, stamp: string, schemas: Record<string, GraphSchema>): void {
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(temporary, JSON.stringify({ stamp, schemas }));
		renameSync(temporary, file);
	} catch {
		// The cache only saves time; a read-only home just means the next start asks the CLI again.
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Nothing was written there, or it cannot be removed; either way the schemas are still returned.
		}
	}
}

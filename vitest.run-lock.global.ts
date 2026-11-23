import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { acquireRunLock } from "./scripts/test/full-run-lock.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * A whole suite (no file filters, not watching) waits for any other full run on this host and holds the lock until its
 * teardown (`scripts/test/full-run-lock.ts`). Runs of named files start at once.
 */
export default async function setup(project: TestProject): Promise<(() => void) | undefined> {
	// Set from the command line's file filters before global setup runs; not part of the typed API.
	const filters = (project.vitest as unknown as { filenamePattern?: string[] }).filenamePattern ?? [];
	if (project.config.watch || filters.length > 0) return undefined;
	const configFile = project.vitest.vite.config.configFile;
	const config = configFile ? ` --config ${path.basename(configFile)}` : "";
	const where = path.relative(repoRoot, project.config.root) || ".";
	return acquireRunLock({ label: `vitest${config} in ${where}` });
}

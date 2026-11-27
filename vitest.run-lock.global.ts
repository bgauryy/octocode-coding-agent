import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { acquireRunLock } from "./scripts/test/full-run-lock.ts";
import { fingerprintTree, recentlyEdited, staleTreeReport } from "./scripts/test/tree-fingerprint.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const RECENT_EDIT_MS = 10_000;

/**
 * A whole suite (no file filters, not watching) waits for any other full run on this host and holds the lock until its
 * teardown (`scripts/test/full-run-lock.ts`). Runs of named files start at once. A whole suite also fingerprints the
 * working tree at setup and teardown and warns, without changing the exit code, when peers edited files in between.
 */
export default async function setup(project: TestProject): Promise<(() => void) | undefined> {
	// Set from the command line's file filters before global setup runs; not part of the typed API.
	const filters = (project.vitest as unknown as { filenamePattern?: string[] }).filenamePattern ?? [];
	if (project.config.watch || filters.length > 0) return undefined;
	const configFile = project.vitest.vite.config.configFile;
	const config = configFile ? ` --config ${path.basename(configFile)}` : "";
	const where = path.relative(repoRoot, project.config.root) || ".";
	const release = await acquireRunLock({ label: `vitest${config} in ${where}` });
	const before = fingerprintTree(repoRoot);
	const recent = recentlyEdited(before, Date.now(), RECENT_EDIT_MS);
	if (recent.length > 0) {
		process.stderr.write(
			`tracked files edited in the last ${RECENT_EDIT_MS / 1000} s, so this run may mix trees: ${recent.slice(0, 5).join(", ")}${recent.length > 5 ? ", …" : ""}\n`,
		);
	}
	const rerun = `yarn vitest run${config}`;
	return () => {
		try {
			const report = staleTreeReport(before, fingerprintTree(repoRoot), rerun);
			if (report) process.stderr.write(`${report}\n`);
		} finally {
			release();
		}
	};
}

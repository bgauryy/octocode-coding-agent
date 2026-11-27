import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { workspaceDb } from "../../src/storage/workspace-database.ts";

/** A database file by path, with the workspace key when it is a workspace file. */
export type HeldFile = { file: string; workspace?: string };

const fixture = fileURLToPath(new URL("./fixtures/hold-workspace-write.mts", import.meta.url));
const resolver = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
let sequence = 0;

/**
 * A separate process holding a write transaction on the file `agent` has open, a workspace file or the machine file;
 * release files work even when the caller's event loop is blocked.
 */
export async function holdWorkspaceWrite(agent: HeldFile) {
	const { file, workspace } = agent;
	const release = `${file}.release-${process.pid}-${++sequence}`;
	const child = spawn(
		process.execPath,
		["--no-warnings", "--import", resolver, fixture, file, release, workspace ?? ""],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	await Promise.race([
		new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
		exited.then((code) => {
			throw new Error(`Lock holder exited before readiness (${code}): ${stderr}`);
		}),
	]);
	return {
		release: () => fs.writeFileSync(release, "release"),
		async close() {
			fs.writeFileSync(release, "release");
			await exited;
			if (child.exitCode !== 0) throw new Error(stderr || `Lock holder exited ${child.exitCode}`);
		},
	};
}

/** The file holding the rows of the workspace at `cwd` under the machine file `machine` (the machine file itself while workspace files are off). */
export const workspaceFileOf = (cwd: string, machine: string): HeldFile =>
	workspaceDb(cwd, { ...process.env, OCTOCODE_AGENT_DB: machine }).agent;

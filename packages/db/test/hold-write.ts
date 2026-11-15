import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/hold-write.mts", import.meta.url));
const resolver = fileURLToPath(new URL("../../coding-agent/scripts/source-resolver.ts", import.meta.url));
let sequence = 0;

/** A separate actual AgentDb transaction; release files work even when the caller's event loop is blocked. */
export async function holdWrite(file: string) {
	const release = `${file}.release-${process.pid}-${++sequence}`;
	const child = spawn(process.execPath, ["--no-warnings", "--import", resolver, fixture, file, release], {
		stdio: ["ignore", "pipe", "pipe"],
	});
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

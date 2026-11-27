import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/build/build-workspace-state.mjs", import.meta.url));

type Run = (args: string[]) => { status: number | null; stderr: string };
const runNode: Run = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });

/** Throws when the generated page bundle no longer matches its sources, so tests never render a stale one. */
export function assertBundleFresh(run: Run = runNode): void {
	const result = run([script, "--check"]);
	if (result.status !== 0)
		throw new Error(
			`The generated webview bundle is stale: tests that render the page would run old code. Run \`yarn run generate:workspace\`.\n${result.stderr}`,
		);
}

/** Vitest global setup: runs once per test run. */
export default function setup(): void {
	assertBundleFresh();
}

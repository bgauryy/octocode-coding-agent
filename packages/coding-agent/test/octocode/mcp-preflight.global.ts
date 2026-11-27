import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The native MCP and skill integration tests start the real Octocode MCP server, linked from the sibling `octocode`
 * checkout. When that build fails its own contract check, about 14 of them fail with timeouts that do not name the
 * cause. This probe starts the server once and, if it refuses to initialize, prints why before the run. It never
 * changes a test's outcome.
 */
export default async function probeOctocodeMcp(): Promise<void> {
	let entry: string;
	try {
		entry = join(dirname(createRequire(import.meta.url).resolve("octocode-mcp/package.json")), "dist", "index.js");
	} catch {
		return;
	}
	const home = mkdtempSync(join(tmpdir(), "octocode-mcp-preflight-"));
	try {
		const failure = await initializeFailure(entry, home);
		if (failure)
			console.warn(
				[
					"",
					"┌─ Octocode MCP server preflight failed ─────────────────────────────────",
					`│ ${entry}`,
					`│ ${failure.slice(0, 400)}`,
					"│ The native MCP and skill integration tests that start this server will fail.",
					"│ Fix: rebuild the sibling checkout (in ../octocode: `yarn contracts:regen`, then build native and octocode-mcp).",
					"└────────────────────────────────────────────────────────────────────────",
					"",
				].join("\n"),
			);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/** Undefined when the server answers `initialize`; otherwise the reason it gave, or a timeout. */
function initializeFailure(entry: string, home: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [entry], {
			env: { ...process.env, HOME: home },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		const done = (failure: string | undefined) => {
			clearTimeout(timer);
			child.kill();
			resolve(failure);
		};
		const timer = setTimeout(() => done("no response to initialize within 20 s"), 20_000);
		const read = (chunk: Buffer) => {
			output += String(chunk);
			if (/"result"\s*:/.test(output)) done(undefined);
			else if (/initialization failed|Contract drift|Error:/i.test(output))
				done(output.trim().split("\n")[0] ?? output);
		};
		child.stdout.on("data", read);
		child.stderr.on("data", read);
		child.on("error", (error) => done(error.message));
		child.on("exit", (code) =>
			done(code === 0 ? "exited before answering" : `exited with code ${code}: ${output.trim().slice(0, 300)}`),
		);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "preflight", version: "1" } } })}\n`,
		);
	});
}

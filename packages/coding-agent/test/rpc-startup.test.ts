import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

it.each(["respond", "stop"])("keeps ordinary RPC startup command ordering while handling UI %s", async (action) => {
	const directory = mkdtempSync(join(tmpdir(), "octocode-rpc-startup-"));
	const extension = join(directory, "startup.mjs");
	const journal = join(directory, "journal.json");
	writeFileSync(
		extension,
		`import { writeFileSync } from "node:fs";
export default function(api) {
  api.on("session_start", async (_event, context) => {
    const answer = await context.ui.select("Startup question", ["Ready"]);
    writeFileSync(${JSON.stringify(journal)}, JSON.stringify({ answer: answer ?? "cancelled" }));
  });
}`,
	);
	const invocation = getCliInvocation();
	const identity = vi.fn();
	const ui = vi.fn();
	const client = new RpcClient({
		invocation: { command: invocation.command, args: invocation.prefix },
		cwd: directory,
		onSessionIdentity: identity,
		args: [
			"--no-mcp",
			"--no-builtin-tools",
			"--no-extensions",
			"--extension",
			extension,
			"--no-skills",
			"--no-context-files",
			"--offline",
		],
		env: {
			PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":"),
			HOME: directory,
			USERPROFILE: directory,
			OCTOCODE_HOME: join(directory, "octocode"),
			OCTOCODE_CODING_AGENT_DIR: join(directory, "agent"),
			OCTOCODE_OFFLINE: "1",
			OCTOCODE_MCP: "0",
			OCTOCODE_API: "0",
			OCTOCODE_INTERNAL_ACP_WORKER: "0",
		},
	});
	client.onExtensionUIRequest(ui);
	try {
		await client.start();
		let stateFinished = false;
		const state = client.getState().finally(() => {
			stateFinished = true;
		});
		void state.catch(() => {});
		// The child CLI boots in about 1s when idle and much slower while the full suite runs in parallel.
		await expect.poll(() => ui.mock.calls.length, { timeout: 20_000 }).toBe(1);
		expect(stateFinished).toBe(false);
		expect(identity).not.toHaveBeenCalled();
		if (action === "respond") {
			await client.respondToExtensionUIRequest({
				type: "extension_ui_response",
				id: ui.mock.calls[0][0].id,
				value: "Ready",
			});
			await expect(state).resolves.toHaveProperty("sessionId");
			expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({ answer: "Ready" });
		} else {
			await client.stop();
			await expect(state).rejects.toThrow("stopped");
			expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({ answer: "cancelled" });
		}
	} finally {
		await client.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

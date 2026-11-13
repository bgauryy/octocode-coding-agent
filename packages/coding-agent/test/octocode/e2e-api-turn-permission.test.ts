import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/octocode/api/client.ts";
import { apiDir, listInstances } from "../../src/octocode/api/registry.ts";
import { seedTrust } from "./e2e-helpers/seed-trust.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	type Sandbox,
	script,
	startEndpoint,
	until,
	writeSettings,
} from "./e2e-real-process-harness.ts";

/**
 * The gate on a turn the local session API starts, through real processes: a headless RPC session in its default `full`
 * mode refuses `octocode-api send` to an idle session (`workspace` mode asks its user, who denies) unless the
 * global `sessionApiTurnPermission` setting is `session`.
 */
let endpoint: Endpoint;
vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

const RESOLVER = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
const API_CLI = fileURLToPath(new URL("../../src/octocode/api/cli.ts", import.meta.url));

function octocodeApi(box: Sandbox, args: string[]) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, ["--no-warnings", "--import", RESOLVER, API_CLI, ...args], {
			cwd: box.project,
			env: box.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

const instancesOf = (box: Sandbox) =>
	listInstances(apiDir({ OCTOCODE_HOME: path.join(box.home, ".octocode", "octocodecode") }));

/** A full-mode headless RPC session with its API up, waiting for the process title the `--to` name uses. */
async function idleSession(box: Sandbox) {
	seedTrust(box);
	const run = box.start(["--mode", "rpc"], { stdin: "pipe" });
	await until(() => instancesOf(box).length > 0, "the API to come up", 60_000);
	const instance = instancesOf(box)[0];
	const status = await new ApiClient(instance).call<{ sessionId: string }>("status");
	await until(() => titleOf(instance.pid).startsWith("octocode-rpc-"), "the process title", 30_000);
	return { run, instance, sessionId: status.sessionId };
}

function titleOf(pid: number): string {
	return (
		execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
			.trim()
			.split(/\s/, 1)[0] ?? ""
	);
}

/** The id of the dialog that asks whether an external message may reach the agent, once the session has sent it. */
function askedAboutMessage(run: { stdout(): string }): string | undefined {
	for (const line of run.stdout().split("\n")) {
		if (!line.includes("Let this external message reach the agent?")) continue;
		return (JSON.parse(line) as { id: string }).id;
	}
	return undefined;
}

describe("a turn the session API starts on an idle full-mode session", () => {
	it("is asked about by default, as in workspace mode, and a denial names the setting; the model is never asked", async () => {
		const box = sandbox(endpoint);
		writeSettings(box, { sessionApiTurnPermission: "workspace" });
		const { run, sessionId } = await idleSession(box);

		const pending = octocodeApi(box, [
			"send",
			"--to",
			sessionId,
			"--from",
			"the test",
			"--wait",
			"--",
			`Please answer. ${script([{ text: "should not run" }])}`,
		]);
		// The session is in full, yet the message is asked about: the turn is held to workspace mode. Its user denies it.
		await until(() => askedAboutMessage(run) !== undefined, "the ask about the message", 60_000);
		run.process.stdin?.write(
			`${JSON.stringify({ type: "extension_ui_response", id: askedAboutMessage(run), value: "Deny" })}\n`,
		);
		const sent = await pending;
		expect(sent.code).not.toBe(0);
		expect(`${sent.stdout}${sent.stderr}`).toContain("sessionApiTurnPermission");
		expect(`${sent.stdout}${sent.stderr}`).toMatch(/not-sent|nothing was sent|not sent/i);
		expect(endpoint.requests).toEqual([]);

		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
	});

	it("runs when the global setting is session", async () => {
		const box = sandbox(endpoint);
		writeSettings(box, { sessionApiTurnPermission: "session" });
		const { run, sessionId } = await idleSession(box);

		const sent = await octocodeApi(box, [
			"send",
			"--to",
			sessionId,
			"--from",
			"the test",
			"--wait",
			"--",
			`Please answer. ${script([{ text: "it ran" }])}`,
		]);
		expect(sent.code, sent.stderr).toBe(0);
		expect(sent.stdout.trim()).toBe("it ran");

		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
	});
});

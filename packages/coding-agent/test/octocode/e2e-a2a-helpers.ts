import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "../../src/octocode/api/client.ts";
import { apiDir, type InstanceRecord, listInstances } from "../../src/octocode/api/registry.ts";
import {
	type Endpoint,
	type ModelRequest,
	type Run,
	type Sandbox,
	script,
	type Step,
	until,
} from "./e2e-real-process-harness.ts";

const RESOLVER = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
const API_CLI = fileURLToPath(new URL("../../src/octocode/api/cli.ts", import.meta.url));

/** `octocode-api` as a person runs it: its own process, in the sandbox's home. */
export function octocodeApi(box: Sandbox, args: string[], cwd = box.project) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, ["--no-warnings", "--import", RESOLVER, API_CLI, ...args], {
			cwd,
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

function titleOf(pid: number): string {
	return (
		execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
			.trim()
			.split(/\s/, 1)[0] ?? ""
	);
}

/** A running session with its API on: an RPC host in `cwd`, and the name others reach it by. */
export async function session(box: Sandbox, cwd?: string) {
	const before = new Set(instancesOf(box).map((instance) => instance.id));
	const run = box.start(["--mode", "rpc"], { stdin: "pipe", ...(cwd ? { cwd } : {}) });
	await until(() => instancesOf(box).some((instance) => !before.has(instance.id)), "the API to come up", 60_000);
	const instance = instancesOf(box).find((each) => !before.has(each.id)) as InstanceRecord;
	const status = await new ApiClient(instance).call<{ sessionId: string }>("status");
	await until(() => titleOf(instance.pid).startsWith("octocode-rpc-"), "the process title", 30_000);
	return { run, instance, sessionId: status.sessionId, name: titleOf(instance.pid) };
}
export type Session = Awaited<ReturnType<typeof session>>;

export const records = (run: Pick<Run, "stdout">) =>
	run
		.stdout()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, any>);

export const prompt = (run: Run, id: string, message: string) =>
	run.process.stdin?.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);

/** The permission dialogs this session has shown, oldest first. */
export const dialogs = (run: Pick<Run, "stdout">) =>
	records(run).filter(
		(record) => record.type === "extension_ui_request" && record.method === "select" && record.permission,
	);

/** Answers a dialog as the terminal would. */
export const answer = (run: Run, id: string, value: string) =>
	run.process.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, value })}\n`);

/** What this session's notices said: `/permissions` and `/worktree` answer there. */
export const notices = (run: Pick<Run, "stdout">) =>
	records(run)
		.filter((record) => record.method === "notify")
		.map((record) => String(record.message))
		.join("\n");

export const close = async (...sessions: Session[]) => {
	for (const each of sessions) each.run.process.stdin?.end();
	await Promise.all(sessions.map((each) => each.run.exited));
};

const source = (steps: string): string => steps.slice("B64SCRIPT:".length);

/** The model requests that answer a script. */
export const requestsOf = (endpoint: Endpoint, steps: string): ModelRequest[] =>
	endpoint.requests.filter((request) => request.script === source(steps));

/** Waits until the model was asked for step `step` of a script: every earlier tool call has its result. */
export const reachedStep = (endpoint: Endpoint, steps: string, step: number, label: string) =>
	until(() => requestsOf(endpoint, steps).some((request) => request.step >= step), label);

export const resultsOf = (endpoint: Endpoint, steps: string): string =>
	requestsOf(endpoint, steps).at(-1)?.toolResults.join("\n") ?? "";

export const message = (to: string, text: string, extra: Record<string, unknown> = {}): Step => ({
	tool: "agent",
	args: { type: "message", to, message: text, ...extra },
});

export const merge = (branch: string): Step => ({
	tool: "agent",
	args: { type: "coordinate", action: "merge", branch },
});

/** A real linked worktree of the sandbox's repository, on its own branch, with one commit its main checkout lacks. */
export function linkedWorktree(box: Sandbox, branch: string, file = "feature.txt", content = "from the worktree\n") {
	const folder = path.join(box.root, `wt-${branch}`);
	execFileSync("git", ["worktree", "add", "-q", "-b", branch, folder], { cwd: box.project, stdio: "ignore" });
	fs.writeFileSync(path.join(folder, file), content);
	execFileSync("git", ["add", "."], { cwd: folder, stdio: "ignore" });
	execFileSync("git", ["commit", "-qm", `work on ${branch}`], { cwd: folder, stdio: "ignore" });
	return fs.realpathSync(folder);
}

export const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export { script };

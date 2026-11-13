import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	type Sandbox,
	sandbox,
	startEndpoint,
} from "./e2e-real-process-harness.ts";

/**
 * The folder-trust prompt of a real interactive start, in a real terminal (tmux): an untrusted project with project
 * configuration asks before anything of it is read; each answer is checked by what it records (`octocode trust list`)
 * and whether a session starts. Everything runs in an isolated `HOME`, so the user's trust records are never touched.
 */
let endpoint: Endpoint;
vi.setConfig({ testTimeout: 120_000 });

const RESOLVER = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});

const sockets: string[] = [];
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	for (const socket of sockets.splice(0)) spawnSync("tmux", ["-L", socket, "kill-server"]);
	await killEverything();
	endpoint.requests.length = 0;
});

/** A sandbox holding a project with project configuration that nobody has decided on. */
function untrustedProject(): Sandbox {
	const box = sandbox(endpoint);
	fs.writeFileSync(path.join(box.project, "AGENTS.md"), "Project rule: answer in rhyme.\n");
	fs.mkdirSync(path.join(box.project, ".octocode"));
	fs.writeFileSync(path.join(box.project, ".octocode", "settings.json"), "{}\n");
	return box;
}

const envArgs = (box: Sandbox) =>
	Object.entries(box.env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${value}`);

/** The CLI as a user starts it (no `--trust`), headless: its exit code and output. */
// Asynchronous: the scripted model answers from this process, which a blocking spawn would starve.
async function headless(box: Sandbox, ...args: string[]) {
	const child = spawn(process.execPath, ["--no-warnings", "--import", RESOLVER, CLI, ...args], {
		cwd: box.project,
		env: box.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout.on("data", (chunk) => (out += chunk));
	child.stderr.on("data", (chunk) => (out += chunk));
	const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
	clearTimeout(timer);
	return { code, out };
}

const trustList = async (box: Sandbox) => (await headless(box, "trust", "list")).out;
const prompt = (text: string) => ["--offline", "--model", "scripted/model", "-p", text];

/** An interactive CLI in a tmux window of its own. */
function terminal(box: Sandbox) {
	const socket = `octo-e2e-${process.pid}-${sockets.length}`;
	sockets.push(socket);
	const tmux = (...args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	const command = [
		"env",
		"-i",
		...envArgs(box),
		JSON.stringify(process.execPath),
		"--no-warnings",
		"--import",
		RESOLVER,
		CLI,
		"--offline",
		"--model",
		"scripted/model",
	]
		.map((part) => (/^[\w@%+=:,./-]+$/.test(part) || part.startsWith('"') ? part : JSON.stringify(part)))
		.join(" ");
	tmux("new-session", "-d", "-x", "120", "-y", "40", "-c", box.project, `${command}; echo EXIT=$?; sleep 600`);
	const screen = () => tmux("capture-pane", "-p", "-t", "0").stdout ?? "";
	return {
		screen,
		keys: (...keys: string[]) => tmux("send-keys", "-t", "0", ...keys),
		async until(predicate: (text: string) => boolean, what: string, ms = 60_000) {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				if (predicate(screen())) return;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error(`Timed out waiting for ${what}. Screen:\n${screen()}`);
		},
	};
}

describe.skipIf(!tmuxAvailable)("folder trust prompt", () => {
	it("an untrusted project asks first, naming the folder and the project files, before any session", async () => {
		const box = untrustedProject();
		const term = terminal(box);
		await term.until((s) => s.includes("Do you trust this folder?"), "trust prompt");
		const screen = term.screen();
		// The folder is shown whole: a path wider than the terminal wraps onto the next indented row.
		expect(screen.replace(/\n +/g, "")).toContain(box.project);
		expect(screen).toContain("Found here:");
		expect(screen).toContain("AGENTS.md");
		expect(screen).toContain("Trust this folder");
		expect(screen).toContain("Do not trust");
		// Nothing was read or sent yet, and nothing is recorded.
		expect(endpoint.requests).toHaveLength(0);
		expect(await trustList(box)).toContain("No trust decisions are stored.");
	});

	it("Trust records a grant and starts the session", async () => {
		const box = untrustedProject();
		const term = terminal(box);
		await term.until((s) => s.includes("Do you trust this folder?"), "trust prompt");
		term.keys("1");
		await term.until((s) => !s.includes("Do you trust this folder?") && /scripted\/model/.test(s), "session started");
		expect(await trustList(box)).toContain(box.project);
		// The next start in the same folder does not ask again.
		spawnSync("tmux", ["-L", sockets[0], "kill-server"]);
		const again = terminal(box);
		await again.until((s) => /scripted\/model/.test(s), "second start");
		expect(again.screen()).not.toContain("Do you trust this folder?");
	});

	it("Do not trust exits, records the refusal and never starts a session", async () => {
		const box = untrustedProject();
		const term = terminal(box);
		await term.until((s) => s.includes("Do you trust this folder?"), "trust prompt");
		term.keys("d");
		await term.until((s) => s.includes("EXIT="), "process exit");
		expect(term.screen()).toMatch(/EXIT=0/);
		expect(term.screen()).not.toMatch(/scripted\/model/);
		expect(endpoint.requests).toHaveLength(0);
		const after = await headless(box, ...prompt("hello"));
		expect(after.code).toBe(1);
		expect(after.out).toContain(box.project);
		expect(endpoint.requests).toHaveLength(0);
	});

	it("Not now exits and records nothing, so the next start asks again", async () => {
		const box = untrustedProject();
		const term = terminal(box);
		await term.until((s) => s.includes("Do you trust this folder?"), "trust prompt");
		term.keys("n");
		await term.until((s) => s.includes("EXIT="), "process exit");
		expect(await trustList(box)).toContain("No trust decisions are stored.");
		const again = terminal(box);
		await again.until((s) => s.includes("Do you trust this folder?"), "second prompt");
	});

	it("a headless run in an untrusted project refuses with exit 1 and sends nothing", async () => {
		const box = untrustedProject();
		const run = await headless(box, ...prompt("hello"));
		expect(run.code).toBe(1);
		expect(run.out).toContain("is not trusted");
		expect(endpoint.requests).toHaveLength(0);
		// `--trust` is the explicit one-time grant: the run goes ahead.
		const trusted = await headless(box, "--trust", ...prompt("hello"));
		expect(trusted.code).toBe(0);
		expect(endpoint.requests.length).toBeGreaterThan(0);
	});
});

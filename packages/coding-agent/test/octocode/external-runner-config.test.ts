import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedRunners, checkRunners, forgetRunner } from "../../src/octocode/external/runner-status.ts";
import { runnerSpec } from "../../src/octocode/external/runners.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function cli(name: string, script: string) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-runner-config-"));
	roots.push(home);
	const bin = path.join(home, "bin");
	const agentDir = path.join(home, "agent");
	fs.mkdirSync(bin);
	fs.mkdirSync(agentDir);
	fs.writeFileSync(
		path.join(bin, name),
		`#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("9.0.0"); process.exit(0); }\n${script}`,
		{ mode: 0o755 },
	);
	return { home, agentDir, env: { PATH: bin, HOME: home } };
}

const claude = () =>
	cli(
		"claude",
		`if (process.env.RUNNER_HANG) {
	require("node:fs").writeFileSync(process.env.RUNNER_HANG, "started");
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else console.log(JSON.stringify({ loggedIn: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN === "fixture-active" || process.env.CLAUDE_CONFIG_DIR?.endsWith("connected")), authMethod: "claude.ai" }));`,
	);

describe("runner configuration and probe isolation", () => {
	it("merges concurrent checks without dropping a completed runner", async () => {
		const fixture = claude();
		fs.writeFileSync(
			path.join(fixture.env.PATH, "codex"),
			`#!${process.execPath}\nconsole.log(process.argv.includes("--version") ? "9.0.0" : "Logged in using ChatGPT");`,
			{ mode: 0o755 },
		);
		const env = { ...fixture.env, CLAUDE_CODE_OAUTH_TOKEN: "fixture-active" };
		const states = await Promise.all(
			["claude-code", "codex"].map((id) => checkRunners({ ids: [id], env, agentDir: fixture.agentDir })),
		);
		expect(states.flat().every((state) => state.auth?.signedIn)).toBe(true);
		expect(cachedRunners(env, fixture.agentDir).map((state) => state.id)).toEqual(["claude-code", "codex"]);
	});

	it("merges checks committed by separate processes sharing one cache", async () => {
		const fixture = claude();
		const gate = path.join(fixture.home, "release");
		for (const [name, status] of [
			["claude", JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })],
			["codex", "Logged in using ChatGPT"],
		]) {
			fs.writeFileSync(
				path.join(fixture.env.PATH, name),
				`#!${process.execPath}\nif(process.argv.includes("--version")){console.log("9.0.0");process.exit(0)}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(fixture.home, name + "-started"))},'');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);console.log(${JSON.stringify(status)})}},10);`,
				{ mode: 0o755 },
			);
		}
		const module = new URL("../../src/octocode/external/runner-status.ts", import.meta.url).href;
		const children = ["claude-code", "codex"].map((id) =>
			spawn(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					`const {checkRunners}=await import(${JSON.stringify(module)});await checkRunners(${JSON.stringify({ ids: [id], env: fixture.env, agentDir: fixture.agentDir, refresh: true })});`,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			),
		);
		const diagnostics: string[] = [];
		for (const child of children) child.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString()));
		const exits = children.map(
			(child) =>
				new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("exit", resolve);
				}),
		);
		try {
			await vi.waitFor(() => {
				expect(diagnostics.join("")).not.toContain("Error");
				expect(fs.existsSync(path.join(fixture.home, "claude-started"))).toBe(true);
				expect(fs.existsSync(path.join(fixture.home, "codex-started"))).toBe(true);
			});
			fs.writeFileSync(gate, "");
			expect(await Promise.all(exits)).toEqual([0, 0]);
			expect(cachedRunners(fixture.env, fixture.agentDir).map((state) => state.id)).toEqual(["claude-code", "codex"]);
			fs.unlinkSync(gate);
			fs.unlinkSync(path.join(fixture.home, "claude-started"));
			const checking = spawn(process.execPath, children[0].spawnargs.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
			children.push(checking);
			const done = new Promise<number | null>((resolve, reject) => {
				checking.once("error", reject);
				checking.once("exit", resolve);
			});
			exits.push(done);
			await vi.waitFor(() => expect(fs.existsSync(path.join(fixture.home, "claude-started"))).toBe(true));
			await forgetRunner("claude-code", fixture.agentDir);
			fs.writeFileSync(gate, "");
			expect(await done).toBe(0);
			expect(cachedRunners(fixture.env, fixture.agentDir).map((state) => state.id)).toEqual(["codex"]);
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.allSettled(exits);
		}
	});

	it("does not resurrect an invalidated runner when an earlier check completes", async () => {
		const fixture = claude();
		const env = { ...fixture.env, CLAUDE_CODE_OAUTH_TOKEN: "fixture-active" };
		await checkRunners({ ids: ["claude-code"], env, agentDir: fixture.agentDir });
		const checking = checkRunners({ ids: ["claude-code"], env, agentDir: fixture.agentDir, refresh: true });
		await forgetRunner("claude-code", fixture.agentDir);
		await checking;
		expect(cachedRunners(env, fixture.agentDir)).toEqual([]);
		await checkRunners({ ids: ["claude-code"], env, agentDir: fixture.agentDir });
		expect(cachedRunners(env, fixture.agentDir)[0].auth?.signedIn).toBe(true);
	});

	it("passes the supplied cleaned environment to the fallback ACP sign-in probe", async () => {
		const peer = fileURLToPath(new URL("../../../acp/test/client/capability-peer.mjs", import.meta.url));
		const fixture = cli(
			"gemini",
			`process.argv = [process.execPath, ${JSON.stringify(peer)}, process.env.RUNNER_JOURNAL, JSON.stringify({ recordEnv: ["RUNNER_CHECK_ENV", "RUNNER_PROCESS_ENV", "ANTHROPIC_API_KEY"] })];
import(${JSON.stringify(pathToFileURL(peer).href)});`,
		);
		const journal = path.join(fixture.home, "probe.jsonl");
		vi.stubEnv("RUNNER_PROCESS_ENV", "process-only");
		const [state] = await checkRunners({
			ids: ["gemini"],
			agentDir: fixture.agentDir,
			env: {
				...fixture.env,
				RUNNER_CHECK_ENV: "supplied",
				RUNNER_JOURNAL: journal,
				ANTHROPIC_API_KEY: "fixture-key",
			},
		});
		expect(state.auth).toEqual({ signedIn: true });
		const events = fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events[0]).toEqual({ event: "env", params: { present: ["RUNNER_CHECK_ENV"] } });
		expect(events.map((event) => event.event)).not.toContain("authenticate");
	});

	it("invalidates cached sign-in when the configured credential path changes even if neither file exists", async () => {
		const fixture = claude();
		const connected = { ...fixture.env, CLAUDE_CONFIG_DIR: path.join(fixture.home, "connected") };
		const disconnected = { ...fixture.env, CLAUDE_CONFIG_DIR: path.join(fixture.home, "signed-out") };
		expect(
			(await checkRunners({ ids: ["claude-code"], env: connected, agentDir: fixture.agentDir }))[0].auth?.signedIn,
		).toBe(true);
		expect(cachedRunners(disconnected, fixture.agentDir)).toEqual([]);
		expect(
			(await checkRunners({ ids: ["claude-code"], env: disconnected, agentDir: fixture.agentDir }))[0].auth?.signedIn,
		).toBe(false);
	});

	it("invalidates exported OAuth token changes without saving the token", async () => {
		const fixture = claude();
		const active = { ...fixture.env, CLAUDE_CODE_OAUTH_TOKEN: "fixture-active" };
		const expired = { ...fixture.env, CLAUDE_CODE_OAUTH_TOKEN: "fixture-invalid" };
		expect(
			(await checkRunners({ ids: ["claude-code"], env: active, agentDir: fixture.agentDir }))[0].auth?.signedIn,
		).toBe(true);
		expect(cachedRunners(expired, fixture.agentDir)).toEqual([]);
		expect(
			(await checkRunners({ ids: ["claude-code"], env: expired, agentDir: fixture.agentDir }))[0].auth?.signedIn,
		).toBe(false);
		const saved = fs.readFileSync(path.join(fixture.agentDir, "external-runners.json"), "utf8");
		expect(saved).not.toContain("fixture-active");
		expect(saved).not.toContain("fixture-invalid");
	});

	it("cancels a status CLI that ignores SIGTERM and preserves the last completed cached check", async () => {
		const fixture = claude();
		const env = { ...fixture.env, CLAUDE_CODE_OAUTH_TOKEN: "fixture-active" };
		await checkRunners({ ids: ["claude-code"], env, agentDir: fixture.agentDir });
		const previous = fs.readFileSync(path.join(fixture.agentDir, "external-runners.json"), "utf8");
		const marker = path.join(fixture.home, "started");
		const controller = new AbortController();
		const checking = checkRunners({
			ids: ["claude-code"],
			env: { ...env, RUNNER_HANG: marker },
			agentDir: fixture.agentDir,
			refresh: true,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
		controller.abort();
		const [state] = await checking;
		expect(state.auth).toBeUndefined();
		expect(state.error).toBeTruthy();
		expect(fs.readFileSync(path.join(fixture.agentDir, "external-runners.json"), "utf8")).toBe(previous);
		expect(cachedRunners(env, fixture.agentDir)[0].auth?.signedIn).toBe(true);
	});

	it("watches Gemini credentials beneath the documented GEMINI_CLI_HOME root", () => {
		expect(runnerSpec("gemini")!.signInFiles({ GEMINI_CLI_HOME: "/isolated" }, "/home/user")).toEqual([
			path.join("/isolated", ".gemini", "oauth_creds.json"),
		]);
	});
});

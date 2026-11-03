import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SCRIPTED_MODEL_ARGS, startModelServer, writeScriptedProvider } from "./helpers/feature-host-cli.ts";
import { trustFolder } from "./octocode/helpers.ts";
import { allowNetwork } from "./test-network-env.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../scripts/source-resolver.ts")).href;

const tempDirs: string[] = [];

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "octocode-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(
	args: string[],
	options: { trusted?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const projectConfigDir = join(projectDir, ".octocode");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });

	const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
	writeFileSync(
		fakeNpmPath,
		['console.log("changed 1 package in 471ms");', 'console.log("found 0 vulnerabilities");', "process.exit(0);"].join(
			"\n",
		),
		"utf-8",
	);

	writeFileSync(
		join(projectConfigDir, "settings.json"),
		JSON.stringify(
			{
				packages: ["npm:fake-package"],
				npmCommand: [process.execPath, fakeNpmPath],
			},
			null,
			2,
		),
		"utf-8",
	);

	// A scripted model endpoint (a `models.json` provider) answers every request, so a startup can finish a turn offline.
	const model = await startModelServer([{ text: "fixture reply" }]);
	writeScriptedProvider({ agentDir }, model);

	// The folder trust gate reads the agent database: the project is trusted the way a user's answer would record it.
	const env = { ...process.env, [ENV_AGENT_DIR]: agentDir, OCTOCODE_HOME: join(tempRoot, "octocode") };
	if (options.trusted) trustFolder(projectDir, env);

	return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd: projectDir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	}).finally(() => model.close());
}

describe("stdout cleanliness in non-interactive modes", () => {
	it("prints plain --help to stdout when stdout is redirected", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).not.toContain("Usage:");
		expect(result.stderr).not.toContain("changed 1 package in 471ms");
		expect(result.stderr).not.toContain("found 0 vulnerabilities");
	});

	it("keeps stdout to JSON events on a trusted --mode json startup, routing package install chatter to stderr", async () => {
		const result = await runCli(
			["--mode", "json", "--no-mcp", "--no-skills", "--no-context-files", ...SCRIPTED_MODEL_ARGS, "hello"],
			{ trusted: true },
		);

		expect(result.stderr).toContain("changed 1 package in 471ms");
		expect(result.stderr).toContain("found 0 vulnerabilities");
		expect(result.code).toBe(0);
		const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(() => JSON.parse(line), line).not.toThrow();
		expect(result.stdout).not.toContain("changed 1 package");
		expect(result.stdout).not.toContain("found 0 vulnerabilities");
	});
});

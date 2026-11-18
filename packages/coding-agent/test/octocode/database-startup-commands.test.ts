import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { runSession } from "../../src/main/run-session.ts";
import { runSubcommand } from "../../src/main/subcommands.ts";
import { tmp } from "./helpers.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

let cwd: string;
let agentDir: string;
let file: string;
beforeEach(() => {
	cwd = tmp("octocode-command-admission-");
	agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir);
	file = path.join(cwd, "missing.db");
	vi.stubEnv("OCTOCODE_AGENT_DB", file);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	closeSharedAgentDb();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = undefined;
});

it.each(["marketplace", "plugin", "context", "trust", "security", "profile", "mcp"])(
	"does not open the database to dispatch %s help",
	async (command) => {
		expect(await runSubcommand([command, "--help"], { cwd, agentDir })).toBe(true);
		expect(process.exitCode).toBe(0);
		expect(fs.existsSync(file)).toBe(false);
	},
);

it("preserves profile's missing-file guard through command dispatch", async () => {
	expect(await runSubcommand(["profile"], { cwd, agentDir })).toBe(true);
	expect(process.exitCode).toBe(1);
	expect(fs.existsSync(file)).toBe(false);
	expect(console.error).toHaveBeenCalledWith(`No stored session in ${cwd}.`);
});

it("returns ACP help before database admission", async () => {
	await runSession(["--mode", "acp", "--help"], {
		cwd,
		agentDir,
		nativeFeatures: nativeFeatureSet(),
		offlineMode: true,
	});
	expect(fs.existsSync(file)).toBe(false);
});

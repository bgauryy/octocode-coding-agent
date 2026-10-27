import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-startup-trust-"));
	cwd = path.join(root, "project");
	agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), JSON.stringify({ sessionDir: "./.sessions" }));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("ignores an untrusted project's settings before trust is decided, such as where sessions are stored", () => {
	expect(SettingsManager.createForStartup(cwd, agentDir).getSessionDir()).toBeUndefined();
});

it("keeps a trusted project's settings at startup", () => {
	new ProjectTrustStore(agentDir).set(cwd, true);
	expect(SettingsManager.createForStartup(cwd, agentDir).getSessionDir()).toBe("./.sessions");
});

it("starts untrusted instead of crashing when trust.json is corrupt", () => {
	fs.writeFileSync(path.join(agentDir, "trust.json"), "{not json");
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		expect(SettingsManager.createForStartup(cwd, agentDir).getSessionDir()).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("trust.json"));
	} finally {
		stderr.mockRestore();
	}
});

it("starts from the saved decision while another process holds trust.json.lock", () => {
	new ProjectTrustStore(agentDir).set(cwd, true);
	const release = lockfile.lockSync(agentDir, {
		realpath: false,
		lockfilePath: path.join(agentDir, "trust.json.lock"),
	});
	try {
		expect(SettingsManager.createForStartup(cwd, agentDir).getSessionDir()).toBe("./.sessions");
	} finally {
		release();
	}
});

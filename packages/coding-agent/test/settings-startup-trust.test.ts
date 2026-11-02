import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

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

it("ignores an untrusted project's settings, such as where sessions are stored", () => {
	expect(SettingsManager.createForStartup(cwd, agentDir, false).getSessionDir()).toBeUndefined();
});

it("keeps a trusted project's settings at startup", () => {
	expect(SettingsManager.createForStartup(cwd, agentDir, true).getSessionDir()).toBe("./.sessions");
});

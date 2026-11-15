import { recordFile, reapOrphanJobs, sessionBashDirs } from "../../src/octocode/files/bash-jobs/records.ts";
import { setCurrentSession, sessionOutputDir, withSessionStorage } from "../../src/storage/runtime-paths.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { hookFiles, loadHooks } from "../../src/octocode/hooks/config.ts";
import { globalPaths, HOME_NAMES, sessionDir, sessionDirName, workspacePaths } from "../../src/octocode/shared/home.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp, vendorSkillFiles } from "./helpers.ts";
import { approveFixtureSkillFiles } from "./guard-helpers.ts";

/** A git repo with `files` written under it, and a nested `pkg/src` folder to start sessions from. */
function repo(files: Record<string, string> = {}): { root: string; sub: string } {
	const root = fs.realpathSync(tmp("octocode-layout-"));
	fs.mkdirSync(path.join(root, ".git"));
	for (const [file, text] of Object.entries(files)) write(path.join(root, file), text);
	const sub = path.join(root, "pkg", "src");
	fs.mkdirSync(sub, { recursive: true });
	return { root, sub };
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

const profile = (name: string, prompt: string) => `---\nname: ${name}\ndescription: d\n---\n${prompt}\n`;

beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp("octocode-layout-agent-"));
});
afterEach(() => vi.unstubAllEnvs());

describe("layout", () => {
	it("puts runtime state under OCTOCODE_HOME, else <home>/.octocode/octocodecode", () => {
		const home = tmp();
		expect(globalPaths({}, home).home).toBe(path.join(home, ".octocode", "octocodecode"));
		expect(globalPaths({}, home).peerCommunication).toBe(path.join(home, ".octocode", "agents-communication"));
		const moved = tmp();
		const paths = globalPaths({ OCTOCODE_HOME: moved }, home);
		expect(paths.home).toBe(moved);
		for (const [key, name] of Object.entries(HOME_NAMES))
			expect(paths[key as keyof typeof HOME_NAMES]).toBe(path.join(moved, name));
		expect(paths.team).toBe(path.join(moved, "team"));
	});

	it("resolves workspace paths from the repository root when started in a subfolder", () => {
		const { root, sub } = repo();
		const paths = workspacePaths(sub);
		expect(paths.root).toBe(root);
		expect(paths).toMatchObject({
			dir: path.join(root, ".octocode"),
			skills: path.join(root, ".octocode", "skills"),
			agents: path.join(root, ".octocode", "agents"),
			hooks: path.join(root, ".octocode", "hooks.json"),
			tmp: path.join(root, ".octocode", "code", "temp"),
		});
	});
});

describe("session folders", () => {
	it("keeps authority to stop jobs in private host state, including when a checkout plants a record", async () => {
		const workspace = repo().root;
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", home);
		try {
			setCurrentSession("owner", workspace);
			const logs = sessionOutputDir("bash");
			const file = recordFile(path.join(logs, "bash-1.log"));
			expect(path.relative(home, file)).toMatch(/^agent[\\/]job-owners[\\/]/);
			expect(path.relative(workspace, file)).toMatch(/^\.\./);
			const forged = path.join(logs, "bash-1.job.json");
			fs.writeFileSync(
				forged,
				JSON.stringify({ id: "bash-1", pid: 999999, log: path.join(logs, "bash-1.log"), owner: { pid: 999998 } }),
			);
			expect(await reapOrphanJobs([logs])).toEqual([]);
			expect(fs.existsSync(forged)).toBe(true);
			expect(sessionBashDirs()).not.toContain(logs);
		} finally {
			setCurrentSession(undefined);
		}
	});
	it("keeps concurrent callbacks and late tool output in the initiating worktree", async () => {
		const a = repo().root;
		const b = repo().root;
		const first = {};
		const second = {};
		const name = "session";
		try {
			setCurrentSession(name, a, first);
			const late = withSessionStorage(first, async () => {
				await new Promise<void>((resolve) => setImmediate(resolve));
				return [sessionOutputDir("output"), sessionOutputDir("archive")];
			});
			setCurrentSession(name, b, second);
			expect(withSessionStorage(second, () => sessionOutputDir("bash"))).toBe(
				path.join(b, ".octocode/code/temp/sessions", name, "bash"),
			);
			expect(await late).toEqual([
				path.join(a, ".octocode/code/temp/sessions", name, "output"),
				path.join(a, ".octocode/code/session-data", name, "archive"),
			]);
		} finally {
			setCurrentSession(undefined);
		}
	});
	it("refuses an id that would name the sessions folder or its parent, and keeps the name of every other id", () => {
		for (const id of ["", ".", "..", "..."]) {
			expect(() => sessionDirName(id), JSON.stringify(id)).toThrow(/Invalid session id/);
			expect(() => sessionDir(id, { OCTOCODE_HOME: tmp() })).toThrow(/Invalid session id/);
		}
		// Ids that were valid keep their folder, so no checkpoints or pending reports are orphaned.
		expect(sessionDirName("a/b c:1")).toBe("a_b_c_1");
		expect(sessionDirName("0190-aaaa-bbbb")).toBe("0190-aaaa-bbbb");
		expect(sessionDirName(".hidden")).toBe(".hidden");
		expect(sessionDirName("a..b")).toBe("a..b");
		expect(sessionDirName("/")).toBe("_");
		expect(sessionDirName("../x")).toBe(".._x");
	});
});

describe("profiles, hooks and skills in .octocode", () => {
	it("profiles: bundled → Octocode Code home → trusted project", () => {
		const home = tmp();
		write(path.join(home, ".octocode", "octocodecode", "agents", "p.md"), profile("p", "octocode-user"));
		write(path.join(home, ".octocode", "octocodecode", "agents", "q.md"), profile("q", "octocode-user"));
		expect(loadProfiles(tmp(), home, true, {}).get("p")?.prompt).toBe("octocode-user");
		const { sub } = repo({
			".octocode/agents/q.md": profile("q", "octocode-project"),
			".octocode/agents/p.md": profile("p", "octocode-project"),
		});
		const trusted = loadProfiles(sub, home, true, {});
		expect(trusted.get("p")?.prompt).toBe("octocode-project");
		expect(trusted.get("q")?.prompt).toBe("octocode-project");
		const untrusted = loadProfiles(sub, home, false, {});
		expect(untrusted.get("p")?.prompt).toBe("octocode-user");
		expect(untrusted.get("q")?.prompt).toBe("octocode-user");
	});

	it("hooks: reads user hooks always and project hooks only when trusted", () => {
		const home = tmp();
		const hook = (command: string) =>
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command }] }] } });
		write(path.join(home, ".octocode", "octocodecode", "hooks.json"), hook("user"));
		const { root, sub } = repo({ ".octocode/hooks.json": hook("project") });
		expect(hookFiles(sub, true, home)).toContain(path.join(root, ".octocode", "hooks.json"));
		const commands = (trusted: boolean) =>
			loadHooks(sub, trusted, home).config.PreToolUse.flatMap((group) =>
				group.hooks.map((item) => ("command" in item ? item.command : undefined)),
			);
		expect(commands(true)).toEqual(["user", "project"]);
		expect(commands(false)).toEqual(["user"]);
	});

	it("skills: loads <root>/.octocode/skills from a subdirectory only when trusted, through core discovery", async () => {
		const home = tmp();
		const { root, sub } = repo({ ".octocode/skills/s/SKILL.md": "---\nname: s\ndescription: Root skill\n---\nBody" });
		approveFixtureSkillFiles(
			[{ name: "s", filePath: path.join(root, ".octocode/skills/s/SKILL.md"), category: "workspace" }],
			sub,
		);
		// Core discovery owns the folder, so the `skills` patterns and project precedence apply to it.
		expect(vendorSkillFiles(sub, home, true, {})).toEqual([]);
		const names = async (projectTrusted: boolean) => {
			const agentDir = tmp();
			const settingsManager = SettingsManager.create(sub, agentDir, { projectTrusted });
			const loader = new DefaultResourceLoader({ nativeFeatures: false, cwd: sub, agentDir, settingsManager });
			await loader.reload();
			return loader.getSkills().skills.map((skill) => skill.name);
		};
		expect(await names(true)).toContain("s");
		expect(await names(false)).not.toContain("s");
	});
});

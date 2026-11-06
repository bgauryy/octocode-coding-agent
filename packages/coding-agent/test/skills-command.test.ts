import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { setupEditorSubmitHandler } from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { handleSkillsCommand } from "../src/modes/interactive/interactive-mode/skills-command.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "skills-command-"));
	roots.push(root);
	vi.stubEnv("HOME", join(root, "home"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const skillPath = join(cwd, ".agents", "skills", "review", "SKILL.md");
	mkdirSync(join(cwd, ".agents", "skills", "review"), { recursive: true });
	writeFileSync(skillPath, "---\nname: review\ndescription: Review code\n---\nReview it.");
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const host = {
		defaultEditor: { onSubmit: async (_text: string) => {} },
		editor: { setText: vi.fn() },
		getSlashCommands: vi.fn(() => []),
		runtimeHost: { services: { agentDir } },
		sessionManager: { getCwd: () => cwd },
		session: {
			settingsManager,
			isStreaming: false,
			isCompacting: false,
			resourceLoader: { getSkills: () => ({ skills: [] as Skill[], diagnostics: [] }) },
		},
		handleReloadCommand: vi.fn(),
		showError: vi.fn(),
		showExtensionSelector: vi.fn().mockResolvedValue(undefined),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		skillCommands: new Map<string, string>(),
		ui: { requestRender: vi.fn() },
	};
	return { root, cwd, agentDir, skillPath, host };
}

it("reports an empty skill search without opening an empty selector", async () => {
	const { host } = fixture();
	expect(await handleSkillsCommand(host as never, "list no-such-skill-7615")).toBe(true);
	expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining("No skills match"));
	expect(host.showExtensionSelector).not.toHaveBeenCalled();
});

it("lists discovered skills with source and load state", async () => {
	const { host, skillPath } = fixture();
	expect(await handleSkillsCommand(host as never, "list")).toBe(true);
	const labels = host.showExtensionSelector.mock.calls[0][1] as string[];
	expect(
		labels.some((label) => label.includes("review") && label.includes(skillPath) && label.includes("not loaded")),
	).toBe(true);
	// A user's own skill is external and says where it came from.
	expect(labels.find((label) => label.includes(skillPath))).toMatch(/ · external · \w+\/\S+ · /);
	expect(host.showError).not.toHaveBeenCalled();
});

it("disables and re-enables an .agents skill through project settings", async () => {
	const { cwd, host, skillPath } = fixture();
	expect(await handleSkillsCommand(host as never, "disable review")).toBe(true);
	expect(host.session.settingsManager.getProjectSettings().skills).toContain(`-${skillPath}`);
	expect(host.handleReloadCommand).toHaveBeenCalledOnce();
	expect(await handleSkillsCommand(host as never, "enable review")).toBe(true);
	expect(host.session.settingsManager.getProjectSettings().skills).toContain(`+${skillPath}`);
	expect(host.session.settingsManager.getProjectSettings().skills).not.toContain(`-${skillPath}`);
	expect(host.handleReloadCommand).toHaveBeenCalledTimes(2);
	expect(JSON.parse(readFileSync(join(cwd, ".octocode", "settings.json"), "utf8")).skills).toContain(`+${skillPath}`);
});

it("controls a trusted workspace .octocode skill", async () => {
	const { cwd, host } = fixture();
	const path = join(cwd, ".octocode", "skills", "deploy", "SKILL.md");
	mkdirSync(join(cwd, ".octocode", "skills", "deploy"), { recursive: true });
	writeFileSync(path, "---\nname: deploy\ndescription: Deploy safely\n---\nDeploy it.");
	await handleSkillsCommand(host as never, "disable deploy");
	expect(host.session.settingsManager.getProjectSettings().skills).toContain(`-${path}`);
	expect(host.handleReloadCommand).toHaveBeenCalledOnce();
});

it("keeps a disabled host-discovered skill addressable for re-enabling", async () => {
	const { root, host } = fixture();
	const path = join(root, "home", ".claude", "skills", "claude-review", "SKILL.md");
	mkdirSync(join(root, "home", ".claude", "skills", "claude-review"), { recursive: true });
	writeFileSync(path, "---\nname: claude-review\ndescription: Review with Claude\n---\nReview it.");
	let loaded: Skill[] = [
		{
			name: "claude-review",
			filePath: path,
			description: "Review with Claude",
			baseDir: join(root, "home", ".claude", "skills", "claude-review"),
			disableModelInvocation: false,
			sourceInfo: { path, source: "path", scope: "user" as const, origin: "top-level" as const },
		},
	];
	host.session.resourceLoader.getSkills = () => ({ skills: loaded, diagnostics: [] });
	await handleSkillsCommand(host as never, "list claude-review");
	expect(host.showExtensionSelector.mock.calls[0][1]).toEqual([
		expect.stringContaining("[loaded, model+user] claude-review"),
	]);
	await handleSkillsCommand(host as never, "disable claude-review");
	expect(host.session.settingsManager.getGlobalSettings().skills).toContain(`-${path}`);
	loaded = [];
	await handleSkillsCommand(host as never, "enable claude-review");
	expect(host.session.settingsManager.getGlobalSettings().skills).toContain(`+${path}`);
	expect(host.session.settingsManager.getGlobalSettings().skills).not.toContain(`-${path}`);
});

it("uses the existing package-resource filter for package skills", async () => {
	const { root, host } = fixture();
	const packageRoot = join(root, "my-package");
	const path = join(packageRoot, "skills", "publish", "SKILL.md");
	mkdirSync(join(packageRoot, "skills", "publish"), { recursive: true });
	writeFileSync(path, "---\nname: publish\ndescription: Publish a release\n---\nPublish it.");
	host.session.settingsManager.setPackages([packageRoot]);
	await handleSkillsCommand(host as never, "disable publish");
	const pkg = host.session.settingsManager.getGlobalSettings().packages?.[0];
	expect(pkg).toMatchObject({ source: packageRoot, skills: ["-skills/publish/SKILL.md"] });
	expect(host.handleReloadCommand).toHaveBeenCalledOnce();
});

it("requires an exact path when names collide, and refuses mutation during a response", async () => {
	const { cwd, host, skillPath } = fixture();
	// Discovery settles a name shared across harnesses (`.octocode` shadows `.agents`), so the collision is within one.
	const otherPath = join(cwd, ".agents", "skills", "other-review", "SKILL.md");
	mkdirSync(join(cwd, ".agents", "skills", "other-review"), { recursive: true });
	writeFileSync(otherPath, "---\nname: review\ndescription: Other review\n---\nReview it.");
	await handleSkillsCommand(host as never, "disable review");
	expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("Several skills are named review"));
	expect(host.handleReloadCommand).not.toHaveBeenCalled();
	host.session.isStreaming = true;
	await handleSkillsCommand(host as never, `disable ${skillPath}`);
	expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("Wait for the current response"));
	expect(host.handleReloadCommand).not.toHaveBeenCalled();
});

it("leaves plain /skills and search terms to the invocation picker", async () => {
	const { host } = fixture();
	expect(await handleSkillsCommand(host as never, "")).toBe(false);
	expect(await handleSkillsCommand(host as never, "review")).toBe(false);
});

it("dispatches /skills disable through the canonical slash command", async () => {
	const { host, skillPath } = fixture();
	setupEditorSubmitHandler(host as never);
	await host.defaultEditor.onSubmit("/skills disable review");
	expect(host.session.settingsManager.getProjectSettings().skills).toContain(`-${skillPath}`);
	expect(host.handleReloadCommand).toHaveBeenCalledOnce();
});

it("opens the full /skills manager and inserts a loaded skill's command", async () => {
	const { host, skillPath } = fixture();
	const loaded: Skill = {
		name: "review",
		filePath: skillPath,
		description: "Review code",
		baseDir: join(skillPath, ".."),
		disableModelInvocation: false,
		sourceInfo: { path: skillPath, source: "auto", scope: "project", origin: "top-level" },
	};
	host.session.resourceLoader.getSkills = () => ({ skills: [loaded], diagnostics: [] });
	host.getSlashCommands.mockImplementation(() => {
		host.skillCommands.set("review", skillPath);
		return [];
	});
	host.showExtensionSelector
		.mockImplementationOnce(async (_title, choices: string[]) => choices.find((label) => label.includes(skillPath)))
		.mockResolvedValueOnce("Use skill");
	setupEditorSubmitHandler(host as never);
	await host.defaultEditor.onSubmit("/skills");
	expect(host.editor.setText).toHaveBeenLastCalledWith("/review ");
	expect(host.ui.requestRender).toHaveBeenCalledOnce();
});

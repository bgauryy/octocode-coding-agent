import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	byText,
	createLoader,
	createSandbox,
	promptFile,
	type Sandbox,
	skillFile,
	themeFile,
	write,
} from "./fixtures.ts";

/** Pi files an Octocode session reads: set only HOME, because an explicit OCTOCODE_HOME turns the Pi roots off. */
let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const skillNames = (loader: { getSkills(): { skills: Array<{ name: string }> } }): string[] =>
	loader
		.getSkills()
		.skills.map((skill) => skill.name)
		.sort(byText);

describe("Pi skills", () => {
	it("loads a Pi skill, and a same-named Octocode skill wins while the Pi copy is shadowed", async () => {
		const piCopy = skillFile(join(sandbox.piAgentDir, "skills"), "demo", { description: "from Pi" });
		const loader = createLoader(sandbox, false);
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => [skill.name, skill.description])).toEqual([["demo", "from Pi"]]);

		const native = skillFile(join(sandbox.agentDir, "skills"), "demo", { description: "from Octocode" });
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.description)).toEqual(["from Octocode"]);
		const items = configDiscovery.discover(
			"skill",
			discoveryInput({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, projectTrusted: false }),
		);
		expect(items.map((item) => [item.provenance.path, item.loaded])).toEqual([
			[native, true],
			[piCopy, false],
		]);
		expect(items[1].provenance.shadowedBy).toMatchObject({ product: "octocode", path: native });
	});

	it("loads project .pi/skills, prompts and themes only in a trusted folder, below nothing Octocode sets", async () => {
		const skill = skillFile(join(sandbox.cwd, ".pi", "skills"), "pi-project-skill");
		const prompt = promptFile(join(sandbox.cwd, ".pi", "prompts"), "pi-project-prompt");
		themeFile(join(sandbox.cwd, ".pi", "themes"), "pi-project-theme");
		const untrusted = createLoader(sandbox, false);
		await untrusted.reload();
		expect(untrusted.getSkills().skills).toEqual([]);
		expect(untrusted.getPrompts().prompts).toEqual([]);
		expect(untrusted.getThemes().themes).toEqual([]);

		const trusted = createLoader(sandbox, true);
		await trusted.reload();
		expect(trusted.getSkills().skills.map((item) => item.filePath)).toEqual([skill]);
		expect(trusted.getPrompts().prompts.map((item) => item.filePath)).toEqual([prompt]);
		expect(trusted.getThemes().themes.map((theme) => theme.name)).toEqual(["pi-project-theme"]);
	});

	it("ranks an Octocode skill of any scope above a Pi project skill of the same name, project before global", async () => {
		skillFile(join(sandbox.agentDir, "skills"), "dup", { description: "octocode global" });
		skillFile(join(sandbox.cwd, ".pi", "skills"), "dup", { description: "pi project" });
		const loader = createLoader(sandbox, true);
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.description)).toEqual(["octocode global"]);
		skillFile(join(sandbox.cwd, ".octocode", "skills"), "dup", { description: "octocode project" });
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.description)).toEqual(["octocode project"]);
	});
});

describe("Pi prompts and themes", () => {
	it("loads global Pi prompts and themes", async () => {
		const prompt = promptFile(join(sandbox.piAgentDir, "prompts"), "pi-prompt");
		themeFile(join(sandbox.piAgentDir, "themes"), "pi-theme");
		const loader = createLoader(sandbox, false);
		await loader.reload();
		expect(loader.getPrompts().prompts.map((item) => item.filePath)).toEqual([prompt]);
		expect(loader.getThemes().themes.map((theme) => theme.name)).toEqual(["pi-theme"]);
	});
});

describe("Pi context and system prompt files", () => {
	it("loads the Pi global AGENTS.md only when Octocode has none", async () => {
		write(join(sandbox.piAgentDir, "AGENTS.md"), "pi rules");
		const piOnly = createLoader(sandbox, false);
		await piOnly.reload();
		expect(piOnly.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual(["pi rules"]);

		write(join(sandbox.agentDir, "AGENTS.md"), "octocode rules");
		await piOnly.reload();
		expect(piOnly.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual(["octocode rules"]);
		const [winner, shadowed] = configDiscovery.discover(
			"context",
			discoveryInput({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, projectTrusted: false }),
		);
		expect(winner).toMatchObject({ loaded: true, provenance: { product: "octocode" } });
		expect(shadowed).toMatchObject({
			loaded: false,
			provenance: { product: "pi", shadowedBy: { product: "octocode" } },
		});
	});

	it("loads Pi SYSTEM.md and APPEND_SYSTEM.md, with Octocode's files first and the project folder trusted", async () => {
		write(join(sandbox.piAgentDir, "SYSTEM.md"), "pi system");
		write(join(sandbox.piAgentDir, "APPEND_SYSTEM.md"), "pi append");
		write(join(sandbox.cwd, ".pi", "SYSTEM.md"), "pi project system");
		const untrusted = createLoader(sandbox, false);
		await untrusted.reload();
		expect(untrusted.getSystemPrompt()).toBe("pi system");
		expect(untrusted.getAppendSystemPrompt()).toEqual(["pi append"]);
		const trusted = createLoader(sandbox, true);
		await trusted.reload();
		expect(trusted.getSystemPrompt()).toBe("pi project system");

		write(join(sandbox.agentDir, "SYSTEM.md"), "octocode system");
		await trusted.reload();
		expect(trusted.getSystemPrompt()).toBe("octocode system");
		write(join(sandbox.cwd, ".octocode", "SYSTEM.md"), "octocode project system");
		await trusted.reload();
		expect(trusted.getSystemPrompt()).toBe("octocode project system");
	});
});

describe("Pi keybindings", () => {
	it("reads ~/.pi/agent/keybindings.json beneath Octocode's own file, per action", () => {
		write(
			join(sandbox.piAgentDir, "keybindings.json"),
			JSON.stringify({ "app.permission.cycle": "ctrl+p", "app.ask.toggle": "ctrl+t" }),
		);
		const piOnly = KeybindingsManager.create(sandbox.agentDir);
		expect(piOnly.getKeys("app.permission.cycle")).toEqual(["ctrl+p"]);
		write(join(sandbox.agentDir, "keybindings.json"), JSON.stringify({ "app.permission.cycle": "ctrl+o" }));
		const both = KeybindingsManager.create(sandbox.agentDir);
		expect(both.getKeys("app.permission.cycle")).toEqual(["ctrl+o"]);
		expect(both.getKeys("app.ask.toggle")).toEqual(["ctrl+t"]);
	});
});

describe("Pi code is not loaded", () => {
	it("reports a Pi extension and a Pi hook as not loaded and never runs them", async () => {
		const marker = join(sandbox.home, "executed");
		const code = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export default function () {}`;
		const extension = write(join(sandbox.piAgentDir, "extensions", "ext.ts"), code);
		const hook = write(join(sandbox.piAgentDir, "hooks", "hook.ts"), code);
		const projectExtension = write(join(sandbox.cwd, ".pi", "extensions", "project.ts"), code);
		const untrusted = createLoader(sandbox, false);
		await untrusted.reload();
		const warnings = (loader: typeof untrusted) => loader.getExtensions().warnings ?? [];
		expect(
			warnings(untrusted)
				.map((warning) => warning.path)
				.sort(byText),
		).toEqual([extension, hook].sort(byText));
		const trusted = createLoader(sandbox, true);
		await trusted.reload();
		expect(
			warnings(trusted)
				.map((warning) => warning.path)
				.sort(byText),
		).toEqual([extension, hook, projectExtension].sort(byText));
		for (const warning of warnings(trusted)) {
			expect(warning.warning).toContain("Pi extension, not loaded");
			expect(warning.warning).toContain("hooks.json");
		}
		expect(trusted.getExtensions().extensions).toEqual([]);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("explicit homes keep Pi off", () => {
	it("reads nothing from Pi when OCTOCODE_HOME is set", async () => {
		vi.stubEnv("OCTOCODE_HOME", join(sandbox.home, "isolated"));
		skillFile(join(sandbox.piAgentDir, "skills"), "pi-global");
		skillFile(join(sandbox.cwd, ".pi", "skills"), "pi-project");
		write(join(sandbox.piAgentDir, "AGENTS.md"), "pi rules");
		write(join(sandbox.piAgentDir, "SYSTEM.md"), "pi system");
		const loader = createLoader({ ...sandbox, agentDir: join(sandbox.home, "isolated") }, true);
		await loader.reload();
		expect(skillNames(loader)).toEqual([]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
		expect(loader.getSystemPrompt()).toBeUndefined();
		expect(loader.getExtensions().warnings ?? []).toEqual([]);
	});
});

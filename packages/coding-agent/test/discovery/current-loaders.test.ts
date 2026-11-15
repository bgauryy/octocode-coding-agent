import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { join } from "node:path";
import { approveFixtureSkillFiles } from "../octocode/guard-helpers.ts";
import { knownReviews } from "../../src/octocode/guard/registry.ts";

/** Pins what the existing loaders read today, so the discovery service starts from the same lists. */
let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const paths = (items: Array<{ filePath: string }>): string[] => items.map((item) => item.filePath).sort(byText);

describe("Octocode resource roots through the resource loader", () => {
	it("reads global, ~/.agents and trusted project skills, prompts and themes", async () => {
		const globalSkill = skillFile(join(sandbox.agentDir, "skills"), "global-skill");
		const agentsSkill = skillFile(join(sandbox.home, ".agents", "skills"), "agents-skill");
		const projectSkill = skillFile(join(sandbox.cwd, ".octocode", "skills"), "project-skill");
		const projectAgentsSkill = skillFile(join(sandbox.cwd, ".agents", "skills"), "project-agents-skill");
		approveFixtureSkillFiles(
			[
				{ name: "global-skill", filePath: globalSkill, category: "global" },
				{ name: "agents-skill", filePath: agentsSkill, category: "global" },
				{ name: "project-skill", filePath: projectSkill, category: "workspace" },
				{ name: "project-agents-skill", filePath: projectAgentsSkill, category: "workspace" },
			],
			sandbox.cwd,
		);
		const globalPrompt = promptFile(join(sandbox.agentDir, "prompts"), "global-prompt");
		const projectPrompt = promptFile(join(sandbox.cwd, ".octocode", "prompts"), "project-prompt");
		themeFile(join(sandbox.agentDir, "themes"), "global-theme");
		themeFile(join(sandbox.cwd, ".octocode", "themes"), "project-theme");
		const loader = createLoader(sandbox, true);
		await loader.reload();
		expect(paths(loader.getSkills().skills)).toEqual(
			[globalSkill, agentsSkill, projectSkill, projectAgentsSkill].sort(byText),
		);
		expect(paths(loader.getPrompts().prompts)).toEqual([globalPrompt, projectPrompt].sort(byText));
		expect(
			loader
				.getThemes()
				.themes.map((theme) => theme.name ?? "")
				.sort(byText),
		).toEqual(["global-theme", "project-theme"]);
	});

	it("reads no project skills, prompts or themes in an untrusted folder", async () => {
		const globalSkill = skillFile(join(sandbox.agentDir, "skills"), "global-skill");
		skillFile(join(sandbox.cwd, ".octocode", "skills"), "project-skill");
		approveFixtureSkillFiles([{ name: "global-skill", filePath: globalSkill, category: "global" }], sandbox.cwd);
		skillFile(join(sandbox.cwd, ".agents", "skills"), "project-agents-skill");
		promptFile(join(sandbox.cwd, ".octocode", "prompts"), "project-prompt");
		themeFile(join(sandbox.cwd, ".octocode", "themes"), "project-theme");
		const loader = createLoader(sandbox, false);
		await loader.reload();
		expect(paths(loader.getSkills().skills)).toEqual([globalSkill]);
		expect(
			knownReviews()
				.filter((review) => review.item.kind === "skill")
				.map((review) => review.item.label),
		).toEqual(["global-skill"]);
		expect(loader.getPrompts().prompts).toEqual([]);
		expect(loader.getThemes().themes).toEqual([]);
	});

	it("reads the global context file and project context files, and only trusted project SYSTEM.md", async () => {
		write(join(sandbox.agentDir, "AGENTS.md"), "global rules");
		write(join(sandbox.cwd, "AGENTS.md"), "project rules");
		write(join(sandbox.cwd, ".octocode", "SYSTEM.md"), "project system");
		write(join(sandbox.agentDir, "APPEND_SYSTEM.md"), "global append");
		const untrusted = createLoader(sandbox, false);
		await untrusted.reload();
		expect(untrusted.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual([
			"global rules",
			"project rules",
		]);
		expect(untrusted.getSystemPrompt()).toBeUndefined();
		expect(untrusted.getAppendSystemPrompt()).toEqual(["global append"]);
		const trusted = createLoader(sandbox, true);
		await trusted.reload();
		expect(trusted.getSystemPrompt()).toBe("project system");
	});
});

describe("Pi global roots through the resource loader", () => {
	it("loads skills, prompts and themes from ~/.pi/agent and ~/.pi, with the Octocode skill winning a name", async () => {
		const piSkill = skillFile(join(sandbox.piAgentDir, "skills"), "pi-skill");
		const piRootSkill = skillFile(join(sandbox.home, ".pi", "skills"), "pi-root-skill");
		const piPrompt = promptFile(join(sandbox.piAgentDir, "prompts"), "pi-prompt");
		themeFile(join(sandbox.piAgentDir, "themes"), "pi-theme");
		const native = skillFile(join(sandbox.agentDir, "skills"), "clash");
		skillFile(join(sandbox.piAgentDir, "skills"), "clash-copy", { name: "clash" });
		approveFixtureSkillFiles(
			[
				{ name: "pi-skill", filePath: piSkill, category: "global" },
				{ name: "pi-root-skill", filePath: piRootSkill, category: "global" },
				{ name: "clash", filePath: native, category: "global" },
			],
			sandbox.cwd,
		);
		const loader = createLoader(sandbox, false);
		await loader.reload();
		expect(paths(loader.getSkills().skills)).toEqual([native, piRootSkill, piSkill].sort(byText));
		expect(loader.getSkills().diagnostics.some((d) => d.type === "collision")).toBe(false);
		expect(paths(loader.getPrompts().prompts)).toEqual([piPrompt]);
		expect(loader.getThemes().themes.map((theme) => theme.name ?? "")).toEqual(["pi-theme"]);
	});

	it("reports user code extensions as ignored and never runs them", async () => {
		const marker = join(sandbox.home, "executed");
		const extension = write(
			join(sandbox.piAgentDir, "extensions", "boom.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export default function () {}`,
		);
		const loader = createLoader(sandbox, false);
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().warnings?.map((warning) => warning.path)).toContain(extension);
		const { existsSync } = await import("node:fs");
		expect(existsSync(marker)).toBe(false);
	});
});

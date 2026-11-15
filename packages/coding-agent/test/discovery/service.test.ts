import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import type { ConfigItem } from "../../src/core/discovery/types.ts";
import { approveFixtureSkillFiles } from "../octocode/guard-helpers.ts";
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

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const input = (projectTrusted: boolean, extra: Record<string, unknown> = {}) =>
	discoveryInput({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, projectTrusted, ...extra });
const loadedPaths = (items: ConfigItem[]): string[] =>
	items
		.filter((item) => item.loaded)
		.map((item) => item.provenance.path)
		.sort(byText);

describe("ConfigDiscovery agrees with the resource loader", () => {
	it("lists the skills, prompts and themes the loader loads, with provenance", async () => {
		const global = skillFile(join(sandbox.agentDir, "skills"), "global-skill");
		const agents = skillFile(join(sandbox.home, ".agents", "skills"), "agents-skill");
		const projectSkill = skillFile(join(sandbox.cwd, ".octocode", "skills"), "project-skill");
		const projectAgents = skillFile(join(sandbox.cwd, ".agents", "skills"), "project-agents-skill");
		const pi = skillFile(join(sandbox.piAgentDir, "skills"), "pi-skill");
		approveFixtureSkillFiles(
			[
				{ name: "global-skill", filePath: global, category: "global" },
				{ name: "agents-skill", filePath: agents, category: "global" },
				{ name: "project-skill", filePath: projectSkill, category: "workspace" },
				{ name: "project-agents-skill", filePath: projectAgents, category: "workspace" },
				{ name: "pi-skill", filePath: pi, category: "global" },
			],
			sandbox.cwd,
		);
		promptFile(join(sandbox.agentDir, "prompts"), "global-prompt");
		promptFile(join(sandbox.cwd, ".octocode", "prompts"), "project-prompt");
		promptFile(join(sandbox.piAgentDir, "prompts"), "pi-prompt");
		themeFile(join(sandbox.agentDir, "themes"), "global-theme");
		themeFile(join(sandbox.piAgentDir, "themes"), "pi-theme");
		const loader = createLoader(sandbox, true);
		await loader.reload();
		const skills = configDiscovery.discover("skill", input(true));
		expect(loadedPaths(skills)).toEqual(
			loader
				.getSkills()
				.skills.map((skill) => skill.filePath)
				.sort(byText),
		);
		expect(loadedPaths(configDiscovery.discover("prompt", input(true)))).toEqual(
			loader
				.getPrompts()
				.prompts.map((prompt) => prompt.filePath)
				.sort(byText),
		);
		expect(
			configDiscovery
				.discover("theme", input(true))
				.map((item) => item.name)
				.sort(byText),
		).toEqual(
			loader
				.getThemes()
				.themes.map((theme) => theme.name ?? "")
				.sort(byText),
		);
		const project = skills.find((item) => item.name === "project-skill")?.provenance;
		expect(project).toMatchObject({ product: "octocode", scope: "project", origin: "octocode" });
		expect(skills.find((item) => item.name === "project-agents-skill")?.provenance.origin).toBe("agents");
		expect(skills.find((item) => item.name === "pi-skill")?.provenance).toMatchObject({
			product: "pi",
			scope: "global",
		});
	});

	it("returns project items of an untrusted folder only when asked, marked not loaded", () => {
		skillFile(join(sandbox.cwd, ".octocode", "skills"), "project-skill");
		expect(configDiscovery.discover("skill", input(false))).toEqual([]);
		const shown = configDiscovery.discover("skill", input(false, { includeUntrusted: true }));
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatchObject({ loaded: false, provenance: { notLoaded: "untrusted", scope: "project" } });
	});

	it("marks the lower-ranked copy of a name as shadowed", () => {
		skillFile(join(sandbox.cwd, ".octocode", "skills"), "dup");
		skillFile(join(sandbox.agentDir, "skills"), "dup");
		skillFile(join(sandbox.piAgentDir, "skills"), "dup");
		const items = configDiscovery.discover("skill", input(true));
		expect(items.map((item) => [item.provenance.scope, item.provenance.product, item.loaded])).toEqual([
			["project", "octocode", true],
			["global", "octocode", false],
			["global", "pi", false],
		]);
		expect(items[1].provenance.shadowedBy).toMatchObject({ scope: "project", product: "octocode" });
	});

	it("ranks the agent directory above a user copy another tool installed", () => {
		skillFile(join(sandbox.home, ".agents", "skills"), "dup");
		const withAgents = configDiscovery.discover("skill", input(false));
		expect(withAgents.find((item) => item.loaded)?.provenance).toMatchObject({ scope: "global", origin: "agents" });
		skillFile(join(sandbox.agentDir, "skills"), "dup");
		const deliberate = configDiscovery.discover("skill", input(false));
		expect(deliberate.find((item) => item.loaded)?.provenance).toMatchObject({ scope: "global", origin: "octocode" });
	});

	it("reports user code as not loaded", () => {
		const file = write(join(sandbox.agentDir, "extensions", "x.ts"), "export default () => {}");
		const [item] = configDiscovery.discover("extension", input(false));
		expect(item).toMatchObject({ name: "x.ts", loaded: false, provenance: { path: file, notLoaded: "ignored-code" } });
	});
});

describe("host-registered sources", () => {
	it("adds a source for a kind core does not own and removes it again", () => {
		const unregister = configDiscovery.register({
			kind: "agent",
			discover: (discoverInput) => [
				{
					kind: "agent",
					name: "audit",
					provenance: {
						product: "octocode",
						vendor: "octocode",
						scope: "global",
						origin: "octocode",
						path: join(discoverInput.agentDir, "hooks.json"),
					},
					loaded: true,
					diagnostics: [],
				},
			],
		});
		expect(configDiscovery.discover("agent", input(false)).map((item) => item.name)).toEqual(["audit"]);
		expect(configDiscovery.discoverAll(input(false)).get("agent")).toHaveLength(1);
		unregister();
		expect(configDiscovery.discover("agent", input(false))).toEqual([]);
	});
});

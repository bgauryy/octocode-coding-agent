import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import type { FeatureSetup } from "../../src/core/features/types.ts";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestFeaturesResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps discovery and invocation aligned without shadowing templates or extensions", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-commands-"));
	roots.push(root);
	const skills: Skill[] = ["research", "review", "custom", "duplicate", "duplicate"].map((name, index) => {
		const filePath = join(root, `${index}.md`);
		writeFileSync(filePath, `Body ${index}`);
		return {
			name,
			filePath,
			description: name,
			baseDir: root,
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: root,
			}),
		};
	});
	let api!: FeatureSetup;
	let featureCalls = 0;
	const featuresResult = await createTestFeaturesResult(
		[
			(host) => {
				api = host;
				host.commands.register("custom", {
					handler: async () => {
						featureCalls++;
					},
				});
			},
		],
		root,
	);
	const loader = createTestResourceLoader({ featuresResult });
	loader.getSkills = () => ({ skills, diagnostics: [] });
	loader.getPrompts = () => ({
		prompts: [
			{
				name: "review",
				description: "Review",
				content: "Template $@",
				filePath: join(root, "review.md"),
				sourceInfo: skills[1].sourceInfo,
			},
			{
				name: "configuration",
				description: "Settings",
				content: "Settings $1",
				filePath: join(root, "configuration.md"),
				sourceInfo: skills[1].sourceInfo,
			},
		],
		diagnostics: [],
	});
	const harness = await createHarness({ resourceLoader: loader, settings: { enableSkillCommands: false } });
	harnesses.push(harness);
	await harness.session.bindFeatures({ mode: "rpc" });
	expect(
		api.resources
			.getCommands()
			.filter((command) => command.source === "prompt")
			.map((command) => command.name),
	).toEqual(["review", "prompt:configuration"]);
	const discovered = api.resources.getCommands().filter((command) => command.source === "skill");
	expect(discovered.map((command) => command.name)).toEqual([
		"research",
		"skill:review",
		"skill:custom",
		"skill:duplicate:1",
		"skill:duplicate:2",
	]);
	expect(discovered[0].sourceInfo).toBe(skills[0].sourceInfo);
	await harness.session.prompt("/custom arguments");
	expect(featureCalls).toBe(1);
	for (const [command, expected] of [
		['/prompt:configuration "quoted argument"', "Settings quoted argument"],
		["/research\tkeep  two spaces", "Body 0"],
		["/skill:research fallback", "Body 0"],
		["/review argument", "Template argument"],
		["/skill:review", "Body 1"],
		["/skill:custom", "Body 2"],
		["/skill:duplicate:2", "Body 4"],
	]) {
		harness.setResponses([fauxAssistantMessage("done")]);
		const before = harness.session.messages.length;
		await harness.session.prompt(command);
		const user = harness.session.messages.slice(before).find((message) => message.role === "user");
		expect(user && getMessageText(user)).toContain(expected);
		if (command.includes("keep")) expect(user && getMessageText(user)).toContain("keep  two spaces");
	}
	// Steered while idle, the expanded input starts a run of its own.
	harness.setResponses([fauxAssistantMessage("done")]);
	const before = harness.session.messages.length;
	await harness.session.steer('/prompt:configuration "steering argument"');
	await harness.session.settled();
	const steered = harness.session.messages.slice(before).find((message) => message.role === "user");
	expect(steered && getMessageText(steered)).toBe("Settings steering argument");
});

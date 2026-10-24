import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
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
	let api!: ExtensionAPI;
	let extensionCalls = 0;
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				api = pi;
				pi.registerCommand("custom", {
					handler: async () => {
						extensionCalls++;
					},
				});
			},
		],
		root,
	);
	const loader = createTestResourceLoader({ extensionsResult });
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
				name: "settings",
				description: "Settings",
				content: "Settings $1",
				filePath: join(root, "settings.md"),
				sourceInfo: skills[1].sourceInfo,
			},
		],
		diagnostics: [],
	});
	const harness = await createHarness({ resourceLoader: loader, settings: { enableSkillCommands: false } });
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "rpc" });
	expect(
		api
			.getCommands()
			.filter((command) => command.source === "prompt")
			.map((command) => command.name),
	).toEqual(["review", "prompt:settings"]);
	const discovered = api.getCommands().filter((command) => command.source === "skill");
	expect(discovered.map((command) => command.name)).toEqual([
		"research",
		"skill:review",
		"skill:custom",
		"skill:duplicate:1",
		"skill:duplicate:2",
	]);
	expect(discovered[0].sourceInfo).toBe(skills[0].sourceInfo);
	await harness.session.prompt("/custom arguments");
	expect(extensionCalls).toBe(1);
	for (const [command, expected] of [
		['/prompt:settings "quoted argument"', "Settings quoted argument"],
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
	await harness.session.steer('/prompt:settings "steering argument"');
	expect(harness.session.getSteeringMessages()).toEqual(["Settings steering argument"]);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import { getSkillCommands } from "../src/core/skill-commands.ts";
import { formatSkillsForPrompt, loadSkillsFromDir } from "../src/core/skills.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function backgroundSkill() {
	const root = mkdtempSync(join(tmpdir(), "skill-visibility-"));
	roots.push(root);
	writeFileSync(
		join(root, "SKILL.md"),
		"---\nname: background\ndescription: Background conventions\nuser-invocable: false\n---\nPrivate expansion marker",
	);
	return loadSkillsFromDir({ dir: root, source: "path" });
}
it("keeps a model-only skill discoverable to the model but out of user commands", () => {
	const loaded = backgroundSkill();
	expect(loaded.diagnostics).toEqual([]);
	expect(getSkillCommands(loaded.skills)).toEqual([]);
	expect(formatSkillsForPrompt(loaded.skills)).toContain("Background conventions");
});
it("does not bypass user-invocable through a qualified skill command", async () => {
	const loader = createTestResourceLoader();
	const loaded = backgroundSkill();
	loader.getSkills = () => loaded;
	const harness = await createHarness({ resourceLoader: loader });
	harnesses.push(harness);
	for (const command of ["/background", "/skill:background"]) {
		harness.setResponses([fauxAssistantMessage("done")]);
		const before = harness.session.messages.length;
		await harness.session.prompt(command);
		const user = harness.session.messages.slice(before).find((message) => message.role === "user");
		expect(user && getMessageText(user)).toBe(command);
	}
});

it("expands explicit Claude plugin skill arguments once through the real session", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-arguments-"));
	roots.push(root);
	writeFileSync(
		join(root, "SKILL.md"),
		"---\nname: review\ndescription: Review\narguments: [file, branch]\n---\n$0 | $file | $branch | $ARGUMENTS",
	);
	const loaded = loadSkillsFromDir({ dir: root, source: "plugin:claude:fixture", protocol: "claude" });
	const loader = createTestResourceLoader();
	loader.getSkills = () => loaded;
	const harness = await createHarness({ resourceLoader: loader });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt('/review "a file" main');
	const user = harness.session.messages.find((message) => message.role === "user");
	expect(user && getMessageText(user)).toContain('a file | a file | main | "a file" main');
	expect(user && getMessageText(user)).not.toContain("$0");
});

it("substitutes Claude session and skill variables after inserting literal arguments", async () => {
	const root = mkdtempSync(join(tmpdir(), "skill-variables-"));
	roots.push(root);
	writeFileSync(
		join(root, "SKILL.md"),
		"---\nname: paths\ndescription: Paths\n---\n$0 | ${CLAUDE_SESSION_ID} | ${CLAUDE_SKILL_DIR} | ${CLAUDE_PROJECT_DIR} | ${UNKNOWN}",
	);
	const loaded = loadSkillsFromDir({ dir: root, source: "path", protocol: "claude" });
	const loader = createTestResourceLoader();
	loader.getSkills = () => loaded;
	const harness = await createHarness({ resourceLoader: loader });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt('/paths "${CLAUDE_SKILL_DIR}"');
	const user = harness.session.messages.find((message) => message.role === "user");
	const text = user && getMessageText(user);
	expect(text).toContain(`${root} | ${harness.session.sessionManager.getSessionId()} | ${root}`);
	expect(text).not.toContain("${CLAUDE_PROJECT_DIR}");
	expect(text).toContain("${UNKNOWN}");
});

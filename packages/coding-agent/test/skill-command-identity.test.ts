import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { renderPrompt } from "../src/core/prompt-template.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "octocode-skill-command-identity-")));
	roots.push(root);
	for (const name of ["original", "replacement"]) {
		fs.mkdirSync(path.join(root, name));
		fs.writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: fixture\ndescription: Fixture\n---\nBODY_${name}`);
	}
	const alias = path.join(root, "alias");
	fs.symlinkSync(path.join(root, "original"), alias, "dir");
	const loaded = loadSkillsFromDir({ dir: alias, source: "test" });
	const loader = createTestResourceLoader();
	loader.getSkills = () => loaded;
	const harness = await createHarness({ resourceLoader: loader });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("done")]);
	const prompt = async (input = "/fixture") => {
		await harness.session.prompt(input);
		const user = harness.session.messages.find((message) => message.role === "user");
		return user && getMessageText(user);
	};
	return { root, alias, prompt };
}

it("expands the captured skill and canonical reference root after its discovery link changes", async () => {
	const { root, alias, prompt } = await fixture();
	fs.unlinkSync(alias);
	fs.symlinkSync(path.join(root, "replacement"), alias, "dir");
	const text = await prompt();
	expect(text).toContain("BODY_original");
	expect(text).not.toContain("BODY_replacement");
	expect(text).toContain(renderPrompt("system/skill-references.md", { dir: path.join(root, "original") }).trim());
});

it("does not expand a captured canonical file replaced by a symlink", async () => {
	const { root, prompt } = await fixture();
	const original = path.join(root, "original", "SKILL.md");
	fs.unlinkSync(original);
	fs.symlinkSync(path.join(root, "replacement", "SKILL.md"), original);
	expect(await prompt()).toBe("/fixture");
});

it("does not expand a mention after its captured canonical file is replaced by a symlink", async () => {
	const { root, prompt } = await fixture();
	const original = path.join(root, "original", "SKILL.md");
	fs.unlinkSync(original);
	fs.symlinkSync(path.join(root, "replacement", "SKILL.md"), original);
	expect(await prompt("Use $fixture")).toBe("Use $fixture");
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getNativeDir } from "../../src/config.ts";
import { PROMPT_FOLDERS } from "../../src/core/prompt-template.ts";
import { SYSTEM_PROMPT_SECTIONS } from "../../src/core/system-prompt-spec.ts";

/**
 * One rule, one place: every native prompt file is used, no section lists a chunk twice, and no sentence of eight or
 * more words is written in two native Markdown files (a shared rule is its own file, included where it applies).
 */
const packages = fileURLToPath(new URL("../../../", import.meta.url));
/** Code that renders prompt files: this package and the MCP package, which renders its sections through the host. */
const CODE_ROOTS = ["coding-agent/src", "mcp/src"].map((root) => path.join(packages, root));

function filesUnder(root: string, ext: string): string[] {
	return fs
		.readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(ext))
		.map((entry) => path.join(entry.parentPath, entry.name));
}

/** Prompt keys (`PROMPT_FOLDERS`) and their text, without READMEs and the generated `final/` prompts. */
function promptFiles(): Map<string, string> {
	const files = new Map<string, string>();
	for (const [folder, prefix] of Object.entries(PROMPT_FOLDERS)) {
		const root = path.join(getNativeDir(), folder);
		for (const file of filesUnder(root, ".md")) {
			const key = prefix + path.relative(root, file).split(path.sep).join("/");
			if (!key.startsWith("final/") && !key.endsWith("README.md")) files.set(key, fs.readFileSync(file, "utf8"));
		}
	}
	return files;
}

/** Sentences of at least `minWords` words, lowercased with punctuation and template tags removed, mapped to their files. */
function repeatedSentences(texts: Map<string, string>, minWords = 8): Array<[string, string[]]> {
	const seen = new Map<string, Set<string>>();
	for (const [name, text] of texts)
		for (const sentence of text.replace(/\{\{[^}]*\}\}/g, " ").split(/(?<=[.!?])\s+|\n/)) {
			const normal = sentence
				.toLowerCase()
				.replace(/[^a-z0-9 ]/g, "")
				.replace(/\s+/g, " ")
				.trim();
			if (normal.split(" ").length >= minWords) seen.set(normal, (seen.get(normal) ?? new Set()).add(name));
		}
	return [...seen].filter(([, names]) => names.size > 1).map(([sentence, names]) => [sentence, [...names].sort()]);
}

describe("prompt chunks", () => {
	const files = promptFiles();

	it("uses every prompt file: by key in code, as an include, or in a section's chunk list", () => {
		const code = CODE_ROOTS.flatMap((root) => filesUnder(root, ".ts"))
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		// A key built from a value (`tools/agent/trigger-${type}.md`) covers the files its pattern matches.
		const patterns = [...code.matchAll(/`([\w/-]*\$\{[^`]*\.md)`/g)].map(
			(match) =>
				new RegExp(
					`^${match[1]
						.split(/\$\{[^}]*\}/)
						.map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
						.join("[\\w-]+")}$`,
				),
		);
		const includes = new Set(
			[...files.values()].flatMap((text) => [...text.matchAll(/\{\{>\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1])),
		);
		const chunks = new Set(SYSTEM_PROMPT_SECTIONS.flatMap((section) => (section.chunks ?? []).map(({ file }) => file)));
		const unused = [...files.keys()].filter(
			(key) =>
				// Profiles are read as a folder (`getSubagentsDir`).
				!key.startsWith("agents/") &&
				!code.includes(`"${key}"`) &&
				!includes.has(key) &&
				!chunks.has(key) &&
				!patterns.some((pattern) => pattern.test(key)),
		);
		expect(unused).toEqual([]);
	});

	it("lists each chunk in one section, once", () => {
		const listed = SYSTEM_PROMPT_SECTIONS.flatMap((section) => (section.chunks ?? []).map(({ file }) => file));
		expect(listed.filter((file, index) => listed.indexOf(file) !== index)).toEqual([]);
	});

	it("writes each sentence once across native prompts, tool text and skills", () => {
		const skills = path.join(getNativeDir(), "skills");
		const texts = new Map(files);
		for (const file of filesUnder(skills, "SKILL.md"))
			texts.set(path.relative(skills, file), fs.readFileSync(file, "utf8"));
		expect(repeatedSentences(texts)).toEqual([]);
	});

	it("finds a repeated sentence, ignoring case, punctuation and template tags, and skips short ones", () => {
		const long = "Never invent tool results, successful tests or approval in any summary.";
		const found = repeatedSentences(
			new Map([
				["a.md", `Intro. ${long} Short and same.`],
				["b.md", `{{#if x}}${long.toUpperCase()}{{/if}}\nShort and same.`],
			]),
		);
		expect(found).toEqual([
			["never invent tool results successful tests or approval in any summary", ["a.md", "b.md"]],
		]);
		expect(repeatedSentences(new Map([["a.md", long]]))).toEqual([]);
	});
});

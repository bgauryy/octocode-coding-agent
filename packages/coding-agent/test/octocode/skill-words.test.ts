import { describe, expect, it } from "vitest";
import {
	buildSkillVocabulary,
	findSkillWords,
	skillWordSources,
	skillWordHighlight,
} from "../../src/octocode/ui/skill-words.ts";

const names = [
	"octocode-brainstorming",
	"octocode-research",
	"octocode-local-research",
	"octocode-github-research",
	"octocode-debugging",
];
const vocabulary = buildSkillVocabulary(names.map((name) => ({ name })));
const words = (line: string) => findSkillWords(line, vocabulary).map((hit) => line.slice(hit.start, hit.end));

describe("skill words", () => {
	it("matches stems and case", () => {
		expect(words("Let us brainstorming, then Debug and RESEARCH.")).toEqual(["brainstorming", "Debug", "RESEARCH"]);
	});
	it("points a word at every skill that names it", () => {
		expect(vocabulary.skillsFor("research")).toEqual([
			"octocode-research",
			"octocode-local-research",
			"octocode-github-research",
		]);
	});
	it("skips partial words, generic parts, paths, files, urls, identifiers and code", () => {
		expect(words("researc local researcher.md src/research.ts https://x.dev/github a_github `github` 'x'")).toEqual([]);
		expect(words("see ./research and `a debug` b")).toEqual([]);
	});
	it("highlights explicit $skill and /skill mentions of loaded skills only", () => {
		expect(words("$octocode-research /octocode-debugging $nope /nope")).toEqual([
			"$octocode-research",
			"/octocode-debugging",
		]);
	});
	it("handles wide text around words", () => {
		expect(findSkillWords("研究 github 日本語", vocabulary)).toEqual([
			{ start: 3, end: 9, skills: ["octocode-github-research"] },
		]);
	});
	it("uses declared triggers", () => {
		const v = buildSkillVocabulary([{ name: "pdf-tools", triggers: ["invoice"] }]);
		expect(findSkillWords("an invoice", v)).toHaveLength(1);
	});
	it("rebuilds when the skill list changes", () => {
		let list = [{ name: "octocode-research" }];
		const highlight = skillWordHighlight(
			() => list,
			(s) => s,
		);
		expect(highlight.find("debug")).toEqual([]);
		list = [{ name: "octocode-debugging" }];
		expect(highlight.find("debug")).toHaveLength(1);
	});
	it("derives skill names from commands", () => {
		expect(
			skillWordSources([
				{ name: "skill:a:2", source: "skill" },
				{ name: "b", source: "skill" },
				{ name: "c", source: "prompt" },
			]),
		).toEqual([{ name: "a" }, { name: "b" }]);
	});
	it("hints the skills of the word under or right after the cursor, and nothing elsewhere", () => {
		const highlight = skillWordHighlight(
			() => names.map((name) => ({ name })),
			(text) => text,
		);
		const line = "go debug it";
		expect(highlight.hintAt(line, 3)).toBe("debug → octocode-debugging");
		expect(highlight.hintAt(line, 8)).toBe("debug → octocode-debugging");
		expect(highlight.hintAt(line, 9)).toBeUndefined();
		expect(highlight.hintAt(line, 1)).toBeUndefined();
		expect(highlight.hintAt("research", 8)).toContain("octocode-local-research, octocode-github-research");
	});
});

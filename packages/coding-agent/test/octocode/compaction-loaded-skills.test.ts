import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactionSummaryText, splitSummary } from "../../src/core/compaction/summary-view.ts";
import {
	carriedLoadedSkills,
	LOADED_SKILLS_DETAILS,
	loadedSkills,
	loadedSkillsLines,
} from "../../src/octocode/compaction/loaded-skills.ts";
import { writeSummary } from "../../src/octocode/compaction/summary.ts";
import { tmp } from "./helpers.ts";
import { asSetup } from "./fake-host.ts";

const model = { provider: "p", id: "m", api: "anthropic-messages", maxTokens: 10_000, contextWindow: 200_000 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
const BODY = "SKILL BODY THE SUMMARY MUST NOT CARRY";

const skillResult = (name: string, location = `/skills/${name}/SKILL.md`, extra: Record<string, unknown> = {}) => ({
	role: "toolResult",
	toolCallId: `call-${name}`,
	toolName: "skill",
	isError: false,
	content: [{ type: "text", text: `<skill name="${name}" location="${location}">\n${BODY}\n</skill>` }],
	details: { name, location, baseDir: "/skills", lines: 1 },
	...extra,
});
const compaction = (id: string, details: unknown, firstKeptEntryId = id) => ({
	type: "compaction",
	id,
	firstKeptEntryId,
	details,
});
const message = (id: string, value: unknown) => ({ type: "message", id, message: value });

function summarize(messages: unknown[], branch: unknown[] = [], previousSummary?: string) {
	const api = asSetup({
		getThinkingLevel: () => "off",
		getActiveTools: () => [],
		getSettings: () => ({}),
		createUsageRecorder: () => () => {},
		appendEntry: () => {},
	}) as never;
	const ctx = {
		model,
		modelRegistry: {
			getCachePolicy: () => ({ options: {} }),
			streamSimple: () => ({
				result: async () => ({
					role: "assistant",
					content: [{ type: "text", text: "## Goal\nwork" }],
					stopReason: "stop",
					usage,
					timestamp: 1,
				}),
			}),
		},
		sessionManager: {
			getSessionId: () => "s",
			getSessionFile: () => "/sessions/s.jsonl",
			getBranch: () => [],
			buildSessionProjection: () => ({ entries: [], messages: [] }),
		},
		hasUI: false,
	} as never;
	const event = {
		preparation: {
			firstKeptEntryId: "k",
			tokensBefore: 1,
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			previousSummary,
			isSplitTurn: false,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: { reserveTokens: 10_000 },
		},
		branchEntries: branch,
		signal: { aborted: false },
	} as never;
	return writeSummary(api, event, ctx);
}

let savedHome: string | undefined;
beforeEach(() => {
	savedHome = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
});

describe("skills loaded before a compaction", () => {
	it("names each loaded skill in one Recovery bullet and in details, never its body", async () => {
		const out = await summarize([skillResult("review"), skillResult("rfc")]);
		const { summary, details } = out!.compaction!;
		const recovery = summary.slice(summary.indexOf("## Recovery"));
		expect(recovery).toContain(
			"- Skills loaded before this summary (load again if the work still needs them): review (/skills/review/SKILL.md), rfc (/skills/rfc/SKILL.md).",
		);
		expect(summary).not.toContain(BODY);
		expect((details as Record<string, unknown>)[LOADED_SKILLS_DETAILS]).toEqual([
			{ name: "review", location: "/skills/review/SKILL.md" },
			{ name: "rfc", location: "/skills/rfc/SKILL.md" },
		]);
	});

	it("keeps the Recovery section in the shape splitSummary removes, so an update never copies the line", async () => {
		const out = await summarize([{ role: "user", content: "go" }, skillResult("review")]);
		const { summary } = out!.compaction!;
		const split = splitSummary(summary);
		expect(split.body).toBe("## Goal\nwork");
		expect(split.messages).toEqual(["go"]);
		expect(compactionSummaryText(summary, 10)).not.toContain("Skills loaded");
	});

	it("keeps listing a skill recorded by an earlier compaction, and adds later ones once", async () => {
		const first = await summarize([skillResult("review")]);
		const branch = [compaction("c1", first!.compaction!.details)];
		const second = await summarize([{ role: "user", content: "go on" }], branch, first!.compaction!.summary);
		expect(second!.compaction!.summary).toContain("review (/skills/review/SKILL.md)");
		const third = await summarize(
			[skillResult("rfc"), skillResult("review", "/moved/SKILL.md")],
			[...branch, compaction("c2", second!.compaction!.details)],
			second!.compaction!.summary,
		);
		expect((third!.compaction!.details as Record<string, unknown>)[LOADED_SKILLS_DETAILS]).toEqual([
			{ name: "review", location: "/moved/SKILL.md" },
			{ name: "rfc", location: "/skills/rfc/SKILL.md" },
		]);
		expect(third!.compaction!.summary.match(/Skills loaded before this summary/g)).toHaveLength(1);
	});

	it("finds the skills a compaction without a record summarized (the default summary)", () => {
		const branch = [
			compaction("c1", { [LOADED_SKILLS_DETAILS]: [{ name: "old", location: "/old/SKILL.md" }] }, "m1"),
			message("m1", skillResult("kept-then-summarized")),
			message("m2", { role: "user", content: "go" }),
			compaction("c2", { readFiles: [] }, "m2"),
		];
		expect(carriedLoadedSkills(branch as never).map((skill) => skill.name)).toEqual(["old", "kept-then-summarized"]);
	});

	it("counts a /skill: block in a user message, and not a failed load or a line-breaking name", () => {
		const block = '<skill name="typed" location="/t/SKILL.md">\nbody\n</skill>\n\nargs';
		const found = loadedSkills([
			{ role: "user", content: [{ type: "text", text: block }] },
			skillResult("failed", undefined, { isError: true }),
			skillResult("line\nbreak"),
			{ ...skillResult("other"), toolName: "bash" },
		]);
		expect(found).toEqual([{ name: "typed", location: "/t/SKILL.md" }]);
		expect(loadedSkillsLines([])).toEqual([]);
	});
});

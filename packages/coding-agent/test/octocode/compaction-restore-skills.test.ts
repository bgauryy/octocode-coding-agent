import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import {
	carriedLoadedSkills,
	LOADED_SKILLS_DETAILS,
	loadedSkills,
	SKILL_POINTER_COMPACTIONS,
} from "../../src/octocode/compaction/loaded-skills.ts";
import {
	RESTORE_SKILL_TOKENS,
	RESTORE_SKILLS,
	RESTORE_SKILLS_TOKENS,
	RESTORED_SKILLS_TYPE,
	restoreLoadedSkills,
} from "../../src/octocode/compaction/restore-skills.ts";
import { asSetup } from "./fake-host.ts";

const block = (name: string, body: string, location = `/skills/${name}/SKILL.md`) =>
	`<skill name="${name}" location="${location}">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>`;
const skillResult = (name: string, body = `${name} rule one\n${name} rule two`) => ({
	role: "toolResult",
	toolCallId: `call-${name}`,
	toolName: "skill",
	isError: false,
	content: [{ type: "text", text: block(name, body) }],
	details: { name, location: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, lines: 2 },
});
const entry = (id: string, message: unknown) => ({ type: "message", id, message });
const compaction = (id: string, skills: unknown) => ({
	type: "compaction",
	id,
	firstKeptEntryId: id,
	details: { [LOADED_SKILLS_DETAILS]: skills },
});
const named = (...names: string[]) => names.map((name) => ({ name, location: `/skills/${name}/SKILL.md` }));

/** A session after a compaction: `branch` holds everything, `kept` what the context still shows. */
function restore(branch: unknown[], kept: unknown[] = [], options: { system?: string; window?: number } = {}) {
	const sent: Array<{
		message: { customType: string; content: string; details: Record<string, unknown> };
		options: unknown;
	}> = [];
	const api = asSetup({
		sendMessage: (message: never, sendOptions: unknown) => void sent.push({ message, options: sendOptions }),
	});
	const ctx = {
		model: { contextWindow: options.window ?? 200_000 },
		getSystemPrompt: () => options.system ?? "",
		sessionManager: {
			getBranch: () => branch,
			buildSessionProjection: () => ({
				entries: kept.map((message, index) => ({ sourceEntry: { id: `k${index}` }, messages: [message] })),
			}),
		},
	};
	return { sent, run: () => restoreLoadedSkills(api, ctx as never) };
}

describe("skill pointers across compactions", () => {
	it("keeps a skill for the compactions that follow its load, and drops it once two summarized no load of it", () => {
		const first = loadedSkills([skillResult("review")]);
		expect(first).toEqual(named("review"));
		const second = loadedSkills([], first);
		expect(second).toEqual([{ ...named("review")[0], idle: 1 }]);
		expect(SKILL_POINTER_COMPACTIONS).toBe(2);
		expect(loadedSkills([], second)).toEqual([]);
		// A load in the span summarized next starts the count again.
		expect(loadedSkills([skillResult("review")], second)).toEqual(named("review"));
	});

	it("ages a recorded skill once for each later compaction that kept no record (the default summary)", () => {
		const branch = [
			compaction("c1", named("old")),
			entry("m1", { role: "user", content: "go" }),
			{ type: "compaction", id: "c2", firstKeptEntryId: "m2", details: {} },
			entry("m2", { role: "user", content: "on" }),
			{ type: "compaction", id: "c3", firstKeptEntryId: "m3", details: {} },
		];
		expect(carriedLoadedSkills(branch as never)).toEqual([]);
		expect(carriedLoadedSkills(branch.slice(0, 3) as never)).toEqual([{ ...named("old")[0], idle: 1 }]);
	});
});

describe("skill bodies after a compaction", () => {
	it("sends the bodies of the two most recently loaded skills the summary carries, as one hidden message", async () => {
		const branch = [
			entry("a", skillResult("alpha")),
			entry("b", skillResult("beta")),
			entry("c", skillResult("gamma")),
			compaction("c1", named("alpha", "beta", "gamma")),
		];
		const { sent, run } = restore(branch);
		expect(RESTORE_SKILLS).toBe(2);
		expect(await run()).toEqual(["gamma", "beta"]);
		expect(sent).toHaveLength(1);
		expect(sent[0].options).toEqual({ triggerTurn: false });
		expect(sent[0].message).toMatchObject({
			customType: RESTORED_SKILLS_TYPE,
			display: false,
			details: { skills: ["gamma", "beta"] },
		});
		const { content } = sent[0].message;
		expect(content).toContain("gamma rule two");
		expect(content).toContain("beta rule one");
		expect(content).not.toContain("alpha rule");
		expect(content.indexOf("gamma rule")).toBeLessThan(content.indexOf("beta rule"));
	});

	it("skips a skill the kept context or the system prompt already shows, and one the summary no longer carries", async () => {
		const branch = [
			entry("a", skillResult("alpha")),
			entry("b", skillResult("beta")),
			entry("c", skillResult("gamma")),
			entry("d", skillResult("delta")),
			compaction("c1", named("alpha", "beta", "gamma")),
		];
		// beta's body is still in the kept tail; gamma is part of the system prompt; delta aged out of the record.
		const { sent, run } = restore(branch, [skillResult("beta")], { system: block("gamma", "inline") });
		expect(await run()).toEqual(["alpha"]);
		expect(sent[0].message.content).toContain("alpha rule one");
		// The restore message kept by the next compaction counts as shown.
		const again = restore(branch, [{ role: "custom", ...sent[0].message }], { system: block("gamma", "inline") });
		expect(await again.run()).toEqual(["beta"]);
	});

	it("restores a skill the system prompt only lists in its catalog, with the file it loads from", async () => {
		const branch = [entry("a", skillResult("alpha")), compaction("c1", named("alpha"))];
		// The catalog form a session without the `skill` tool lists: name and file, not the skill's text.
		const catalog = `<skills>\n  <skill name="alpha" location="/skills/alpha/SKILL.md">Alpha rules.</skill>\n</skills>`;
		const { sent, run } = restore(branch, [], { system: catalog });
		expect(await run()).toEqual(["alpha"]);
		expect(sent[0].message.content).toContain("alpha rule one");
	});

	it("cuts a long skill at a line within its budget and names the file that holds the rest", async () => {
		const long = Array.from({ length: 4_000 }, (_, line) => `step ${line + 1}: do the thing carefully`).join("\n");
		const branch = [
			entry("a", skillResult("long", long)),
			entry("b", skillResult("other", long)),
			compaction("c1", named("long", "other")),
		];
		const { sent, run } = restore(branch);
		expect(await run()).toEqual(["other", "long"]);
		const { content, details } = sent[0].message;
		expect(details.cut).toEqual(["other", "long"]);
		expect(content.length).toBeLessThanOrEqual(RESTORE_SKILLS_TOKENS * CHARS_PER_TOKEN);
		for (const name of ["long", "other"]) {
			const start = content.indexOf(`<skill name="${name}"`);
			const end = content.indexOf("</skill>", start) + "</skill>".length;
			expect(end - start).toBeLessThanOrEqual(RESTORE_SKILL_TOKENS * CHARS_PER_TOKEN);
			expect(content.slice(start, end)).toContain(`/skills/${name}/SKILL.md; read it when the work needs it`);
		}
		expect(content).toContain("step 1: do the thing");
		expect(content).not.toContain("step 4000:");
	});

	it("fits a small window and sends nothing when no carried skill has a body to show", async () => {
		const long = "x".repeat(2_000).concat("\n").repeat(10);
		const small = restore([entry("a", skillResult("big", long)), compaction("c1", named("big"))], [], {
			window: 8_000,
		});
		expect(await small.run()).toEqual([]);
		expect(small.sent).toEqual([]);
		const none = restore([compaction("c1", named("gone"))]);
		expect(await none.run()).toEqual([]);
		expect(none.sent).toEqual([]);
	});
});

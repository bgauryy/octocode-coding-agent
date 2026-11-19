import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { renderReport } from "../../src/octocode/guard/report.ts";
import { decide, forget, type GuardOptions, resolveReviews } from "../../src/octocode/guard/store.ts";
import type { ItemFile, ReviewItem } from "../../src/octocode/guard/types.ts";
import { tmp } from "./helpers.ts";

let options: GuardOptions;

beforeEach(() => {
	options = { env: { ...process.env, OCTOCODE_AGENT_DB: path.join(tmp("octocode-guard-diff-"), "agent.db") } };
});
afterEach(() => closeSharedAgentDb());

const item = (files: ItemFile[]): ReviewItem => ({
	kind: "skill",
	id: "skill:/x/SKILL.md",
	identity: "skill:/x",
	scope: "global",
	label: "x",
	path: "/x/SKILL.md",
	grants: ["Instructions the agent follows"],
	floor: "LOW",
	files,
});
const text = (name: string, body: string): ItemFile => ({ name, text: body });
const approveThen = (before: ItemFile[], after: ItemFile[]) => {
	const [first] = resolveReviews([item(before)], options);
	if (!first) throw new Error("no review");
	decide(first, "approved", "test", options);
	const [now] = resolveReviews([item(after)], options);
	if (!now) throw new Error("no review");
	return now;
};

describe("security report diff", () => {
	it("shows changed lines, new files and removed files since approval", () => {
		const review = approveThen(
			[text("SKILL.md", "one\ntwo\n"), text("old.sh", "echo")],
			[text("SKILL.md", "one\nthree\n"), text("new.sh", "ls")],
		);
		expect(review.changed).toBe(true);
		const report = renderReport(review);
		expect(report).toContain("Changed since you approved it");
		expect(report).toContain("~ SKILL.md");
		expect(report).toContain("- two");
		expect(report).toContain("+ three");
		expect(report).toContain("+ new.sh  (new file)");
		expect(report).toContain("- old.sh  (file removed)");
	});

	it("shows hidden characters in changed lines as text", () => {
		const report = renderReport(approveThen([text("SKILL.md", "a\n")], [text("SKILL.md", "a\u200bb\n")]));
		expect(report).toContain("[U+200B]");
	});

	it("says content was not kept for a binary file", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const changed = approveThen(
			[{ name: "b.bin", text: "", bytes }],
			[{ name: "b.bin", text: "", bytes: new Uint8Array([9]) }],
		);
		expect(renderReport(changed)).toContain("content not kept");
	});

	it("adds no changes section to an unchanged approved item", () => {
		const review = approveThen([text("SKILL.md", "a")], [text("SKILL.md", "a")]);
		expect(review.word).toBe("approved");
		expect(renderReport(review)).not.toContain("Changed since");
	});

	it("compares against the latest approval, not the first", () => {
		const second = approveThen([text("SKILL.md", "a")], [text("SKILL.md", "b")]);
		decide(second, "approved", "test", options);
		const [third] = resolveReviews([item([text("SKILL.md", "c")])], options);
		if (!third) throw new Error("no review");
		const report = renderReport(third);
		expect(report).toContain("- b");
		expect(report).not.toContain("- a");
	});

	it("shows no diff once the decision is forgotten", () => {
		const changed = approveThen([text("SKILL.md", "a")], [text("SKILL.md", "b")]);
		forget(changed, options);
		const [fresh] = resolveReviews([item([text("SKILL.md", "b")])], options);
		if (!fresh) throw new Error("no review");
		expect(fresh.changed).toBe(false);
		expect(renderReport(fresh)).not.toContain("Changed since");
	});
});

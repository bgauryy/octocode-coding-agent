// Recurring tool-result text carries a fact once: a line that only repeats the header or an earlier line is left out.
import type { Member } from "@octocodeai/octocode-contracts/team";
import { describe, expect, it } from "vitest";
import {
	beginVerification,
	finishVerification,
	foregroundReceipt,
	verificationText,
} from "../../src/octocode/files/bash/verification.ts";
import { recordMutation } from "../../src/octocode/files/feedback/revisions.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { registerConfinedNote } from "../../src/octocode/team/node-confine.ts";
import { fakeHost } from "./fake-host.ts";

const member = (id: string, cwd: string, branch: string): Member => ({
	id,
	role: "main",
	pid: process.pid,
	status: "idle",
	joinedAt: 0,
	updatedAt: 0,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	cwd,
	branch,
});

describe("verification text", () => {
	it("is empty for a clean exit and kept when it adds something", () => {
		const clean = foregroundReceipt(beginVerification("ok", "/repo", "vt-clean"), null, { exit_code: 0 }, {});
		expect(verificationText(clean)).toBe("");
		const failed = finishVerification(beginVerification("bad", "/repo", "vt-fail"), {
			code: 3,
			signal: null,
			seconds: 1,
		});
		expect(verificationText(failed)).toContain("exit 3");
		const start = beginVerification("edit meanwhile", "/repo", "vt-edit");
		recordMutation("vt-edit");
		const edited = foregroundReceipt(start, null, { exit_code: 0 }, {});
		expect(verificationText(edited)).toContain("Verification:");
	});
});

describe("coordinate list", () => {
	it("names another place, not the viewer's own, and a shared log folder once", () => {
		const a = member("a", "/repo", "main");
		const b = member("b", "/repo", "main");
		const c = member("c", "/repo/other", "feature");
		const details = new Map(
			[a, b, c].map((m) => [m.id, { transcripts: "/repo/logs" }] as const),
		) as unknown as Parameters<typeof describeMembers>[7];
		const text = describeMembers([a, b, c], "a", 0, undefined, undefined, undefined, [], details);
		expect(text.match(/ {2}in \/repo @ main/g)).toBeNull();
		expect(text).toContain("  in /repo/other @ feature");
		expect(text.match(/ {2}log: /g)).toHaveLength(1);
	});
});

describe("reservation notes", () => {
	it("gives the full note once, then the short form", async () => {
		const host = fakeHost();
		const mark = registerConfinedNote(host.api);
		const run = async (id: string) => {
			mark(id, "FULL", "SHORT");
			const out = (await host.fire(
				"tool_result",
				{ toolCallId: id, toolName: "bash", input: {}, content: [{ type: "text", text: "ok" }] },
				{},
			)) as { content: Array<{ text: string }> };
			return out.content.at(-1)!.text;
		};
		expect(await run("1")).toBe("FULL");
		expect(await run("2")).toBe("SHORT");
	});

	it("gives the full note again after compaction, which summarized the first one away", async () => {
		const host = fakeHost();
		const mark = registerConfinedNote(host.api);
		const run = async (id: string) => {
			mark(id, "FULL", "SHORT");
			const out = (await host.fire(
				"tool_result",
				{ toolCallId: id, toolName: "bash", input: {}, content: [{ type: "text", text: "ok" }] },
				{},
			)) as { content: Array<{ text: string }> };
			return out.content.at(-1)!.text;
		};
		expect(await run("1")).toBe("FULL");
		expect(await run("2")).toBe("SHORT");
		await host.fire("session_compact", {}, {});
		expect(await run("3")).toBe("FULL");
		expect(await run("4")).toBe("SHORT");
	});
});

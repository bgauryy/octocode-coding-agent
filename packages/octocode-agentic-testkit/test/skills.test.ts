import { describe, expect, it } from "vitest";
import { runInproc, type Skill } from "../src/agents/inproc.ts";
import { script } from "../src/gateway.ts";
import { gateway } from "./helpers.ts";

const skills: Skill[] = [
	{ name: "pdf", description: "Work with PDF files", body: "PDF-BODY" },
	{ name: "sql", description: "Write SQL queries", body: "SQL-BODY" },
];

describe("skill triggers", () => {
	it("detects a load_skill call and lists skills in the system prompt", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "load_skill", args: { name: "pdf" } }] }, { text: "done" }]),
		});
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, skills }, "merge two pdfs");
		expect(gw.trace).toHaveLoadedSkill("pdf");
		expect(gw.trace).not.toHaveLoadedSkill("sql");
		expect(String(gw.trace.requests[0].messages[0].content)).toContain("- sql: Write SQL queries");
		expect(JSON.stringify(gw.trace.requests[1].messages)).toContain("PDF-BODY");
	});

	it("does not trigger when the model answers directly", async () => {
		const gw = await gateway({ responder: script([{ text: "no skill needed" }]) });
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, skills }, "what is 2+2");
		expect(gw.trace).not.toHaveLoadedSkill("pdf");
		expect(gw.trace).not.toHaveLoadedSkill("sql");
	});

	it("detects a SKILL.md read (octocode-agent style)", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "read", args: { path: "/x/skills/pdf/SKILL.md" } }] }, { text: "ok" }]),
		});
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace }, "go");
		expect(gw.trace).toHaveLoadedSkill("pdf");
	});

	it("fails with a clear message and cannot-observe on an empty trace", async () => {
		const gw = await gateway();
		expect(() => expect(gw.trace).toHaveLoadedSkill("pdf")).toThrow(/cannot observe/);
	});
});

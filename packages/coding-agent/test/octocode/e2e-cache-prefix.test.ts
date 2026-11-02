import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { nativeCall } from "./e2e-calls.ts";
import { disposeSessions, headless, restoreEnv, say } from "./e2e-headless.ts";
import { tmp } from "./helpers.ts";

/**
 * Provider caching reads the request from the start: whatever one request carries must open the next one unchanged. The
 * transcript is append-only (prompt and tool changes ride in system messages), so the check is on the serialized
 * messages of two consecutive requests of a real Octocode session: request N+1 begins with request N and its reply.
 */
afterEach(() => {
	vi.useRealTimers();
	disposeSessions();
});
afterAll(restoreEnv);

const serialized = (context: TranscriptContext, count = context.messages.length) =>
	JSON.stringify(context.messages.slice(0, count));

/** What request `next` shares with request `previous`: true when `next` opens with all of `previous`'s messages. */
const extendsPrefix = (previous: TranscriptContext, next: TranscriptContext) =>
	next.messages.length > previous.messages.length &&
	serialized(next, previous.messages.length) === serialized(previous);

const toolTurn =
	(...calls: ReturnType<typeof nativeCall>[]) =>
	() =>
		fauxAssistantMessage(calls, { stopReason: "toolUse" });

describe("consecutive requests of an Octocode session share their prefix", () => {
	it("two plain prompts: the second request opens with the first", async () => {
		const s = await headless();
		await s.run("first", [say("one")]);
		await s.run("second", [say("two")]);
		expect(s.contexts).toHaveLength(2);
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
	});

	it("the turns of one prompt (a tool call, then the answer)", async () => {
		const s = await headless();
		await s.run("read it", [toolTurn(nativeCall("bash", { command: "echo hi" })), say("done")]);
		expect(s.contexts).toHaveLength(2);
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
	});

	it("a thinking-level switch between prompts leaves the transcript prefix alone", async () => {
		const s = await headless();
		await s.run("first", [say("one")]);
		s.session.setThinkingLevel("high");
		await s.run("second", [say("two")]);
		s.session.setThinkingLevel("off");
		await s.run("third", [say("three")]);
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
		expect(extendsPrefix(s.contexts[1], s.contexts[2])).toBe(true);
	});

	it("changing the active tools between prompts appends the change; the declarations already sent stay", async () => {
		const s = await headless();
		await s.run("first", [say("one")]);
		const names = s.session.getActiveToolNames();
		s.session.setActiveToolsByName(names.filter((name) => name !== "archive"));
		await s.run("second", [say("two")]);
		s.session.setActiveToolsByName(names);
		await s.run("third", [say("three")]);
		// Not vacuous: the removal is a system message after the first request's messages.
		expect(serialized(s.contexts[1]).slice(serialized(s.contexts[0]).length)).toContain("toolsRemoved");
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
		expect(extendsPrefix(s.contexts[1], s.contexts[2])).toBe(true);
	});

	it("the date rolling over between prompts (the volatile `environment` section) is appended, not rewritten", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T12:00:00Z") });
		const s = await headless();
		await s.run("first", [say("one")]);
		vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
		await s.run("second", [say("two")]);
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
		// Not vacuous: the new date is in the second request, as a message after the first request's.
		expect(serialized(s.contexts[0])).not.toContain("2026-11-04");
		expect(serialized(s.contexts[1]).slice(serialized(s.contexts[0]).length)).toContain("2026-11-04");
	});
});

/**
 * `/reload` re-reads AGENTS.md files and skills. The base system message of the first request is never rewritten: what
 * changed rides in one appended system message that carries only the sections that differ (`project_context` for
 * AGENTS.md, `skills` for skills), so the earlier request stays a byte-identical prefix that the provider may read at its
 * cache-read rate. Byte identity enables reuse; it does not prove a hit, retention or billing, which only provider usage shows.
 */
describe("a /reload between prompts", () => {
	const skill = (dir: string, name: string, description: string) => {
		fs.mkdirSync(path.join(dir, name), { recursive: true });
		fs.writeFileSync(
			path.join(dir, name, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`,
		);
	};
	const agents = (cwd: string, rule: string) => fs.writeFileSync(path.join(cwd, "AGENTS.md"), `Rule: ${rule}.\n`);

	async function session() {
		const skills = tmp("skills-");
		skill(skills, "alpha", "Original alpha description.");
		const s = await headless({
			setup: ({ cwd }) => agents(cwd, "ORIGINAL-RULE"),
			resources: { contextFiles: true, skillPaths: [skills] },
		});
		await s.run("first", [say("one")]);
		return { s, skills };
	}

	/** The sections of each system message `next` appended after `previous`'s messages and its reply, and their text. */
	const appended = (previous: TranscriptContext, next: TranscriptContext) => {
		const added = next.messages
			.slice(previous.messages.length)
			.filter((message) => message.role === "system") as unknown as Array<{ sections: Record<string, string> }>;
		return { sections: added.map((message) => Object.keys(message.sections)), text: JSON.stringify(added) };
	};

	it("a changed skill is appended as the skills section alone", async () => {
		const { s, skills } = await session();
		skill(skills, "alpha", "Changed alpha description.");
		skill(skills, "beta", "Brand new beta.");
		await s.session.reload();
		await s.run("second", [say("two")]);
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
		const change = appended(s.contexts[0], s.contexts[1]);
		expect(change.sections).toEqual([["skills"]]);
		expect(change.text).toContain("Changed alpha description.");
		expect(change.text).toContain("Brand new beta.");
		// Not vacuous: the first request carried the original, and the change is not in its prefix.
		expect(serialized(s.contexts[0])).toContain("Original alpha description.");
		expect(serialized(s.contexts[0])).not.toContain("Changed alpha description.");
	});

	it("a changed AGENTS.md is appended as the project_context section alone", async () => {
		const { s } = await session();
		agents(s.cwd, "CHANGED-RULE");
		await s.session.reload();
		await s.run("second", [say("two")]);
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
		const change = appended(s.contexts[0], s.contexts[1]);
		expect(change.sections).toEqual([["project_context"]]);
		expect(change.text).toContain("CHANGED-RULE");
		expect(serialized(s.contexts[0])).toContain("ORIGINAL-RULE");
		expect(serialized(s.contexts[0])).not.toContain("CHANGED-RULE");
	});

	it("a reload that changes nothing appends nothing", async () => {
		const { s } = await session();
		await s.session.reload();
		await s.run("second", [say("two")]);
		expect(extendsPrefix(s.contexts[0], s.contexts[1])).toBe(true);
		expect(appended(s.contexts[0], s.contexts[1]).sections).toEqual([]);
	});
});

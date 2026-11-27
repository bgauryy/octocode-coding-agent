import fs from "node:fs";
import path from "node:path";
import { getCurrentSystemMessage, getCurrentTools, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_ITEM_ENV } from "@octocodeai/octocode-common/env";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { VOLATILE_SECTIONS } from "../../src/core/system-prompt-spec.ts";
import { findToolCacheBoundary } from "../../src/core/tool-roles.ts";
import { memoryStore } from "../../src/octocode/memory/store.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { captureChild } from "./agent-context/capture.ts";
import { instructionBlocks, toolsText } from "./agent-context/fingerprint.ts";
import { disposeSessions, headless, restoreEnv, say } from "./e2e-headless.ts";
import { approveFixtureSkillFiles } from "./guard-helpers.ts";
import { tmp } from "./helpers.ts";

/**
 * The cached prefix is the tool array plus the base and session instruction blocks. State that changes between sessions
 * of one repository (memories, the backlog board, the date, the order skills were written) must reach the model through
 * the volatile block or the messages, never through those bytes. These tests drive real sessions on a scripted model and
 * compare what each request carried; the existing prefix guards are in e2e-cache-prefix.test.ts,
 * instruction-cache-boundary.test.ts and cache-prefix-session.test.ts.
 */
afterEach(() => {
	vi.useRealTimers();
	disposeSessions();
});
afterAll(restoreEnv);

const serialized = (context: TranscriptContext, count = context.messages.length) =>
	JSON.stringify(context.messages.slice(0, count));

const conversation = (context: TranscriptContext) =>
	JSON.stringify(context.messages.filter((message) => message.role !== "system"));

/** The tool array, as declared. */
const toolBytes = (context: TranscriptContext) =>
	JSON.stringify(
		getCurrentTools(context.messages).map(({ name, description, parameters }) => ({ name, description, parameters })),
	);

/** Every system section outside the volatile tier, in order: the bytes both cached instruction blocks are made of. */
const cachedSections = (context: TranscriptContext) =>
	Object.entries(getCurrentSystemMessage(context.messages)?.sections ?? {}).filter(
		([name]) => !VOLATILE_SECTIONS.has(name),
	);

const sectionNames = (context: TranscriptContext) =>
	Object.keys(getCurrentSystemMessage(context.messages)?.sections ?? {});

const MEMORY_TITLE = "Prefix audit pinned preference";

/** Env the session will see, for seeding stores before it starts. */
const sessionEnv = (root: string, home: string): NodeJS.ProcessEnv => ({
	...process.env,
	HOME: home,
	OCTOCODE_HOME: path.join(home, ".octocode"),
	OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
});

function seedBoard(env: NodeJS.ProcessEnv, cwd: string): void {
	Object.assign(process.env, env);
	const { agent, workspace } = workspaceDb(cwd, env);
	for (const [seq, title] of [
		[1, "Prefix audit open item one"],
		[2, "Prefix audit open item two"],
	] as const)
		agent.db
			.prepare(
				"INSERT INTO backlog (workspace_id, seq, title, state, created_by, created_at, updated_at, priority) VALUES (?, ?, ?, 'todo', 'user', 0, ?, 0)",
			)
			.run(workspace.id, seq, title, Date.now());
	memoryStore(cwd, env).set({ title: MEMORY_TITLE, scope: "global", pinned: true, author: "user" });
	closeSharedAgentDb();
}

describe("two sessions of one repository that differ in stored state", () => {
	it("send the same tools and cached instruction sections; memories and the backlog digest ride in the messages", async () => {
		const empty = await headless();
		await empty.run("first", [say("one")]);
		const seeded = await headless({
			setup: ({ root, cwd, home }) => seedBoard(sessionEnv(root, home), cwd),
		});
		await seeded.run("first", [say("one")]);
		const [a, b] = [empty.contexts[0], seeded.contexts[0]];

		// Not vacuous: the stored state reached the second session's model, and only through its messages.
		expect(conversation(b)).toContain(MEMORY_TITLE);
		expect(conversation(b)).toContain("Prefix audit open item one");
		expect(conversation(a)).not.toContain(MEMORY_TITLE);
		expect(JSON.stringify(getCurrentSystemMessage(b.messages))).not.toContain(MEMORY_TITLE);
		expect(JSON.stringify(getCurrentSystemMessage(b.messages))).not.toContain("Prefix audit open item");

		expect(toolBytes(b)).toBe(toolBytes(a));
		expect(cachedSections(b)).toEqual(cachedSections(a));
		expect(sectionNames(b)).toEqual(sectionNames(a));
	});

	it("a memory saved between two prompts is appended; the first request stays a prefix", async () => {
		const s = await headless();
		await s.run("first", [say("one")]);
		memoryStore(s.cwd).set({ title: MEMORY_TITLE, scope: "global", pinned: true, author: "user" });
		await s.run("second", [say("two")]);
		const [first, second] = s.contexts;
		expect(serialized(second, first.messages.length)).toBe(serialized(first));
		// Not vacuous: the memory is new text after the first request's messages.
		expect(serialized(first)).not.toContain(MEMORY_TITLE);
		expect(serialized(second).slice(serialized(first).length)).toContain(MEMORY_TITLE);
	});
});

describe("the skill list", () => {
	const NAMES = ["alpha", "bravo", "charlie", "delta"];

	/** Writes the skills in `order`, each one second newer than the one before, so file times and creation order both follow it. */
	function writeSkills(dir: string, order: string[]): void {
		fs.rmSync(dir, { recursive: true, force: true });
		const base = Date.parse("2026-01-01T00:00:00Z") / 1000;
		order.forEach((name, index) => {
			fs.mkdirSync(path.join(dir, name), { recursive: true });
			const file = path.join(dir, name, "SKILL.md");
			fs.writeFileSync(file, `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`);
			fs.utimesSync(file, base + index, base + index);
		});
	}

	async function skillsSection(skills: string): Promise<string> {
		const s = await headless({
			setup: ({ root, cwd, home }) =>
				approveFixtureSkillFiles(
					NAMES.map((name) => ({ name, filePath: path.join(skills, name, "SKILL.md"), category: "global" as const })),
					cwd,
					{ env: sessionEnv(root, home) },
				),
			resources: { skillPaths: [skills] },
		});
		await s.run("first", [say("one")]);
		return getCurrentTools(s.contexts[0].messages).find((tool) => tool.name === "skill")?.description ?? "";
	}

	it("does not depend on the order the skill folders were written", async () => {
		const skills = fs.realpathSync(tmp("skills-"));
		writeSkills(skills, NAMES);
		const forward = await skillsSection(skills);
		writeSkills(skills, [...NAMES].reverse());
		const backward = await skillsSection(skills);
		const listedFiles = forward
			.split("\n")
			.filter((line) => line.includes("SKILL.md:"))
			.map((line) => line.split(": ")[0]);
		expect(listedFiles).toEqual(NAMES.map((name) => path.join(skills, name, "SKILL.md")));
		expect(backward).toBe(forward);
	});
});

describe("the tool array", () => {
	it("is declared in one order whatever order the active tools were set in", async () => {
		const s = await headless();
		const names = s.session.getActiveToolNames();
		const declared = () => s.session.agent.state.tools.map((tool: { name: string }) => tool.name);
		s.session.setActiveToolsByName(names);
		const forward = declared();
		s.session.setActiveToolsByName([...names].reverse());
		const backward = declared();
		// Not vacuous: several tools are declared.
		expect(forward.length).toBeGreaterThan(5);
		expect(backward).toEqual(forward);
	});

	it("a child that names a backlog item and a sibling that does not share the tools before the cache boundary", async () => {
		const tools = async (item: string | undefined) => {
			const s = await headless({
				env: { OCTOCODE_SUBAGENT: "1", ...(item ? { [BACKLOG_ITEM_ENV]: item } : {}) },
			});
			await s.run("task", [say("done")]);
			const variant = new Set(
				s.session.agent.state.tools
					.filter((tool: { roleVariant?: boolean }) => tool.roleVariant)
					.map((t: { name: string }) => t.name),
			);
			return getCurrentTools(s.contexts[0].messages).map(({ name, description, parameters }) => ({
				name,
				variant: variant.has(name),
				bytes: JSON.stringify({ name, description, parameters }),
			}));
		};
		const [plain, withItem] = [await tools(undefined), await tools("B1")];
		// Not vacuous: the item makes the child declare one more tool.
		expect(withItem.map((tool) => tool.name)).toContain("backlog");
		expect(plain.map((tool) => tool.name)).not.toContain("backlog");
		const shared = (list: typeof plain) => {
			const names = list.map((tool) => tool.name);
			const boundary = findToolCacheBoundary(names, (name) => list.some((tool) => tool.name === name && tool.variant));
			return list.slice(0, names.indexOf(boundary!)).map((tool) => tool.bytes);
		};
		expect(shared(withItem).length).toBeGreaterThan(0);
		expect(shared(withItem)).toEqual(shared(plain));
	});
});

describe("children of one profile started on different days", () => {
	it.each([undefined, "implementer"])(
		"profile %s: only the volatile block moves",
		async (role) => {
			vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T09:00:00Z") });
			const monday = await captureChild(role ?? "general", role);
			vi.setSystemTime(new Date("2026-11-09T23:30:00Z"));
			const later = await captureChild(role ?? "general", role);
			expect(instructionBlocks(monday).session).toBeTruthy();
			expect(toolsText(later)).toBe(toolsText(monday));
			expect(instructionBlocks(later).base).toBe(instructionBlocks(monday).base);
			expect(instructionBlocks(later).session).toBe(instructionBlocks(monday).session);
		},
		120_000,
	);
});

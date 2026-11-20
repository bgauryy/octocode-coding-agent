import { approveFixtureMcp, approveFixtureSkillFiles } from "./guard-helpers.ts";
import fs from "node:fs";
import path from "node:path";
import {
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	normalizeContext,
	type Tool,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { stream as anthropicStream } from "@octocodeai/octocode-ai/api/anthropic-messages";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { findToolCacheBoundary } from "../../src/core/tool-roles.ts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { nativeCall } from "./e2e-calls.ts";
import { disposeSessions, headless, restoreEnv, say } from "./e2e-headless.ts";
import { tmp } from "./helpers.ts";
import {
	baseEnv,
	captureChild,
	captureMain,
	fixture,
	scriptedSession,
	withEnv,
	type AgentContext,
	type Fixture,
	type ParentSkillCatalog,
} from "./agent-context/capture.ts";
import { instructionBlocks, toolsText } from "./agent-context/fingerprint.ts";

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
		// Not vacuous: the scripted transport cannot remove a tool in place, so the change is an announcement after the
		// first request's messages, and the declaration stays.
		const appended = serialized(s.contexts[1]).slice(serialized(s.contexts[0]).length);
		expect(appended).toContain("tools_off");
		expect(appended).not.toContain("toolsRemoved");
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

describe("deferred tools under the default exposure", () => {
	it("calling a deferred MCP tool and a deferred native tool for the first time leaves every earlier request a prefix", async () => {
		const fx = fixture();
		try {
			const docs = path.join(import.meta.dirname, "fixtures", "docs-mcp.mjs");
			// No `exposure` and no `mcpExposure`: the default `recent` defers tools this folder never called.
			fs.writeFileSync(
				path.join(fx.agentDir, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						octocode: { command: "false", enabled: false },
						docs: { command: process.execPath, args: [docs] },
					},
				}),
			);
			const contexts = await withEnv(baseEnv(fx), async () => {
				const { session, faux, end } = await scriptedSession(fx, {});
				const seen: TranscriptContext[] = [];
				const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
					seen.push(structuredClone(context));
					return reply;
				};
				try {
					faux.setResponses([
						record(
							fauxAssistantMessage([nativeCall("mcp__docs__lookup", { query: "guide" })], { stopReason: "toolUse" }),
						),
						record(fauxAssistantMessage([nativeCall("archive", { op: "list" })], { stopReason: "toolUse" })),
						record(fauxAssistantMessage("one")),
						record(
							fauxAssistantMessage([nativeCall("mcp__docs__lookup", { query: "api" })], { stopReason: "toolUse" }),
						),
						record(fauxAssistantMessage("two")),
					]);
					await session.prompt("first");
					await session.prompt("second");
				} finally {
					await end();
				}
				return seen;
			});
			expect(contexts).toHaveLength(5);
			// Not vacuous: the MCP tool was declared deferred (no field docs) in the first request.
			const declared = getCurrentTools(contexts[0].messages);
			const lookup = declared.find((tool) => tool.name === "mcp__docs__lookup");
			expect(lookup).toBeDefined();
			expect(JSON.stringify(lookup?.parameters)).not.toContain("Title words to search for.");
			// `archive` is on demand on this transport: undeclared at first, declared after the head once called.
			expect(declared.map((tool) => tool.name)).not.toContain("archive");
			expect(getCurrentTools(contexts[2].messages).map((tool) => tool.name)).toContain("archive");
			for (let index = 1; index < contexts.length; index++)
				expect(extendsPrefix(contexts[index - 1], contexts[index]), `request ${index + 1}`).toBe(true);
		} finally {
			fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
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
			setup: ({ root, cwd, home }) => {
				agents(cwd, "ORIGINAL-RULE");
				approveFixtureSkillFiles(
					[{ name: "alpha", filePath: path.join(skills, "alpha", "SKILL.md"), category: "global" }],
					cwd,
					{
						env: {
							...process.env,
							OCTOCODE_HOME: path.join(home, ".octocode"),
							OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
						},
					},
				);
			},
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
		approveFixtureSkillFiles(
			["alpha", "beta"].map((name) => ({
				name,
				filePath: path.join(skills, name, "SKILL.md"),
				category: "global" as const,
			})),
			s.cwd,
		);
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
		// Only the edited file's part of the section is sent.
		expect(change.sections).toEqual([[expect.stringMatching(/^project_context:.*\/project\/AGENTS\.md$/)]]);
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

/**
 * The cached prefix is the tool array plus the base and session instruction blocks. A new process of the same
 * configuration must send the same bytes, whatever its clock, process id or the order in which its MCP servers connect,
 * or it pays to write the whole prefix again. The one allowed difference is the volatile block (`cwd`, the
 * `environment` section with the date, MCP status), which follows the session block and has no cache breakpoint.
 */
describe("the prefix of one configuration does not depend on the process", () => {
	const WRAPPER = (delay: number) =>
		`await new Promise((resolve) => setTimeout(resolve, ${delay}));\nawait import(${JSON.stringify(path.join(import.meta.dirname, "fixtures", "docs-mcp.mjs"))});\n`;

	async function render(
		fx: Fixture,
		run: {
			now: string;
			pid: number;
			order: ["docs-a" | "docs-b", "docs-a" | "docs-b"];
			delays: Record<string, number>;
		},
	): Promise<AgentContext> {
		const servers = Object.fromEntries(
			run.order.map((name) => {
				const file = path.join(fx.root, `${name}-${run.delays[name]}.mjs`);
				fs.writeFileSync(file, WRAPPER(run.delays[name]));
				return [name, { command: process.execPath, args: [file], exposure: "direct", description: name }];
			}),
		);
		fs.writeFileSync(
			path.join(fx.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { octocode: { command: "false", enabled: false }, ...servers } }),
		);
		const pid = Object.getOwnPropertyDescriptor(process, "pid")!;
		vi.useFakeTimers({ toFake: ["Date"], now: new Date(run.now) });
		Object.defineProperty(process, "pid", { value: run.pid, configurable: true });
		try {
			return await withEnv(baseEnv(fx), async () => {
				approveFixtureMcp(fx.cwd, fx.agentDir);
				const { session, faux, end } = await scriptedSession(fx, {});
				try {
					let captured: TranscriptContext | undefined;
					faux.setResponses([
						(context: TranscriptContext) => {
							captured ??= context;
							return fauxAssistantMessage("ready");
						},
					]);
					await session.prompt("hello");
					if (!captured) throw new Error("The scripted model received no request");
					const system = getCurrentSystemMessage(captured.messages);
					const sections = Object.entries(system?.sections ?? {}).map(([name, text]) => ({ name, text: String(text) }));
					return {
						name: "main",
						kind: "main",
						sections,
						tools: getCurrentTools(captured.messages).map((tool) => ({
							name: tool.name,
							description: tool.description ?? "",
							parameters: tool.parameters ?? null,
						})),
						messages: [],
					};
				} finally {
					await end();
				}
			});
		} finally {
			Object.defineProperty(process, "pid", pid);
			vi.useRealTimers();
		}
	}

	it("sends identical tools, base block and session block for another clock, pid and MCP connection order", async () => {
		const fx = fixture();
		try {
			const first = await render(fx, {
				now: "2026-11-01T12:00:00Z",
				pid: 1111,
				order: ["docs-a", "docs-b"],
				delays: { "docs-a": 0, "docs-b": 700 },
			});
			const second = await render(fx, {
				now: "2026-11-01T13:30:00Z",
				pid: 2222,
				order: ["docs-b", "docs-a"],
				delays: { "docs-a": 700, "docs-b": 0 },
			});
			// Not vacuous: both servers are in the prefix, and the two renders are real prompts.
			expect(first.tools.map((tool) => tool.name)).toEqual(
				expect.arrayContaining(["mcp__docs_a__lookup", "mcp__docs_b__lookup"]),
			);
			expect(instructionBlocks(first).session).toBeTruthy();
			expect(toolsText(second)).toBe(toolsText(first));
			expect(instructionBlocks(second)).toEqual(instructionBlocks(first));
		} finally {
			fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("changes only the environment section when the date changes", async () => {
		const fx = fixture();
		try {
			const config = {
				pid: 1,
				order: ["docs-a", "docs-b"] as ["docs-a", "docs-b"],
				delays: { "docs-a": 0, "docs-b": 0 },
			};
			const today = await render(fx, { ...config, now: "2026-11-01T12:00:00Z" });
			const later = await render(fx, { ...config, now: "2026-11-04T12:00:00Z" });
			expect(toolsText(later)).toBe(toolsText(today));
			expect(instructionBlocks(later).base).toBe(instructionBlocks(today).base);
			// The date sits in the third block: the session block is not rewritten either.
			expect(instructionBlocks(today).session).toBeTruthy();
			expect(instructionBlocks(later).session).toBe(instructionBlocks(today).session);
			expect(instructionBlocks(later).volatile).not.toBe(instructionBlocks(today).volatile);
			// Only the date field of the environment changes.
			const without = (context: AgentContext) =>
				context.sections.filter((section) => section.name !== "environment:date");
			expect(without(later)).toEqual(without(today));
			expect(later.sections.find((section) => section.name === "environment:date")?.text).not.toBe(
				today.sections.find((section) => section.name === "environment:date")?.text,
			);
		} finally {
			fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});

/**
 * Siblings of one profile must share their cached prefix: the task, goal and identity ride in the first user message,
 * so the system prompt and the tool array may not depend on them. These cases hold the prefix task-independent.
 */
describe("two children of one profile with different tasks", () => {
	const tasks = [
		{ task: "Find where the retry policy is configured.", goal: "Name the file and line." },
		{ task: "Review the diff of the session manager for races, then list findings by severity.", goal: "A verdict." },
	];
	it.each([undefined, "researcher", "implementer"])(
		"profile %s sends the same system prompt and tool array",
		async (role) => {
			// Real siblings inherit one parent catalog, even while an installed package is rebuilt.
			const parentSkills: ParentSkillCatalog = {};
			const [a, b] = [
				await captureChild(role ?? "general", role, tasks[0], { parentSkills }),
				await captureChild(role ?? "general", role, tasks[1], { parentSkills }),
			];
			expect(parentSkills.snapshot?.resources.length).toBeGreaterThan(0);
			// Not vacuous: the tasks do differ in what each child reads first.
			expect(a.messages.map((message) => message.text)).not.toEqual(b.messages.map((message) => message.text));
			expect(toolsText(b)).toBe(toolsText(a));
			expect(b.sections).toEqual(a.sections);
			expect(instructionBlocks(b)).toEqual(instructionBlocks(a));
		},
	);
});

/**
 * Agents of different roles declare their tools in one order (`orderToolNames`): the tools every role declares alike
 * first (native tools, then the MCP tools of the servers they share), the role-specific ones last. The request marks the
 * end of that shared prefix (`toolCacheBoundary`), so an agent of one role reads the tool prefix another role wrote on
 * the same model. A role that defers its MCP tools (`mcpDefer`, the implementer) declares them shorter and shares that
 * prefix with its own role only.
 */
describe("agents of different roles", () => {
	it("send the same tool bytes and cache breakpoint up to the end of the shared tools", async () => {
		const contexts: AgentContext[] = [await captureMain()];
		for (const role of ["general", "researcher", "reviewer"])
			contexts.push(await captureChild(role, role === "general" ? undefined : role));
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const sent = await Promise.all(
			contexts.map(async (context) => {
				const tools = context.tools.map(({ name, description, parameters }) => ({
					name,
					description,
					parameters: parameters as Tool["parameters"],
				}));
				const boundary = findToolCacheBoundary(
					tools.map((tool) => tool.name),
					(name) => context.tools.some((tool) => tool.name === name && tool.roleVariant),
				);
				let payload: { tools?: Array<{ cache_control?: unknown }>; system?: Array<{ cache_control?: unknown }> } = {};
				await anthropicStream(model, normalizeContext({ systemPrompt: "x", messages: [], tools }), {
					apiKey: "sk-ant-api-test",
					env: {},
					cacheRetention: "short",
					instructionCacheRetention: "long",
					toolCacheBoundary: boundary,
					onPayload: (value) => {
						payload = structuredClone(value) as typeof payload;
						throw new Error("captured");
					},
				}).result();
				const declared = payload.tools ?? [];
				const marked = declared.findIndex((tool) => tool.cache_control !== undefined);
				return {
					boundary,
					marked,
					prefix: JSON.stringify(declared.slice(0, marked + 1)),
					whole: JSON.stringify(declared),
					markers: [...declared, ...(payload.system ?? [])].filter((block) => block.cache_control).length,
				};
			}),
		);
		// The breakpoint sits on the same tool, the last before the first role-specific one (`backlog` in the main
		// session, `agent` in a child: its `memory` and `archive` stay deferred), in every role.
		expect(sent.map((request) => request.boundary)).toEqual(["backlog", "agent", "agent", "agent"]);
		expect(sent.every((request) => request.marked === sent[0].marked && request.marked > 0)).toBe(true);
		expect(new Set(sent.map((request) => request.prefix)).size).toBe(1);
		// One instruction marker on the tools, one on the prompt: two stay for the history.
		expect(sent.map((request) => request.markers)).toEqual(sent.map(() => 2));
		// Not vacuous: the main session's tool array differs from a child's, and the shared prefix is most of it.
		expect(sent[0].whole).not.toBe(sent[1].whole);
		expect(sent[1].prefix.length).toBeGreaterThan(sent[1].whole.length * 0.8);
	}, 120_000);
});

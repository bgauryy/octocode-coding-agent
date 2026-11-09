import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory, ToolDefinition } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createReadToolDefinition } from "../fixtures/read-tool.ts";
import { Mail } from "../../src/octocode/team/mail.ts";
import { trustFolder } from "./helpers.ts";
import { nativeCall } from "./e2e-calls.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Hermetic: a run from inside a Octocode subagent inherits its identity and settings, which change the prompt, tools and limits.
// OCTOCODE_HOME and OCTOCODE_AGENT_DB stay: setup-env.ts points them at this worker's sandbox, and without them the
// agent database (trust grants included) resolves to the developer's real ~/.octocode.
for (const key of [
	"OCTOCODE_SUBAGENT",
	"OCTOCODE_BROWSER_VISIBLE",
	"OCTOCODE_PARENT_ID",
	"OCTOCODE_AGENT_ID",
	"OCTOCODE_AGENT_GOAL",
	"OCTOCODE_MAX_SUBAGENTS",
	"OCTOCODE_MEMORY_AUTO",
	"OCTOCODE_MCP",
]) {
	delete process.env[key];
}

const FIXTURE = path.join(HERE, "fixtures", "echo-mcp.mjs");

// The extension launches its `octocode-mcp` dependency as is: in this monorepo the pinned version resolves to the
// workspace build (`packages/octocode-mcp`), so the e2e runs the server source and release share.

interface Turn {
	systemPrompt: string;
	tools: string[];
	toolContracts: ReturnType<typeof getCurrentTools>;
	lastResults: Array<{ toolName: string; isError: boolean; text: string }>;
	/** Every tool result in the request, oldest first (`lastResults` is only the trailing run). */
	allResults: Array<{ toolName: string; isError: boolean; text: string }>;
}

function snapshot(context: TranscriptContext): Turn {
	const results: Turn["lastResults"] = [];
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index] as {
			role: string;
			toolName?: string;
			isError?: boolean;
			content?: unknown;
		};
		if (message.role === "system") continue; // tool/prompt deltas are recorded as system messages
		if (message.role !== "toolResult") break;
		const text = Array.isArray(message.content)
			? message.content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";
		results.unshift({ toolName: String(message.toolName), isError: message.isError === true, text });
	}
	const toolContracts = getCurrentTools(context.messages);
	return {
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: toolContracts.map((tool) => tool.name),
		toolContracts,
		lastResults: results,
		allResults: context.messages.flatMap((message) => {
			const result = message as { role: string; toolName?: string; isError?: boolean; content?: unknown };
			if (result.role !== "toolResult") return [];
			const text = Array.isArray(result.content)
				? result.content.map((part: { text?: string }) => part.text ?? "").join("")
				: "";
			return [{ toolName: String(result.toolName), isError: result.isError === true, text }];
		}),
	};
}

type Reply = ReturnType<typeof fauxAssistantMessage>;

/** An MCP tool result as the model reads it: wrapped as untrusted data, with the server's text inside. */
const UNTRUSTED = (tool: string, body: string) =>
	new RegExp(
		`^Result of ${tool}:\\n<<<untrusted-(\\w+) \\(text from a web page or an MCP server[^\\n]*\\n${body}\\nuntrusted-\\1>>>$`,
	);

/** A real Octocode agent session running the Octocode extension against a scripted model. */
async function startSession(
	mcpServers: Record<string, unknown>,
	options: {
		tools?: string[];
		legacyTools?: boolean;
		settings?: Record<string, unknown>;
		agentSettings?: Record<string, unknown>;
		models?: Array<{ id: string; inputCost: number; maxTokens: number }>;
	} = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-e2e-"));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	if (options.agentSettings)
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(options.agentSettings));
	// The user trusted this project with Octocode's /trust.
	trustFolder(cwd);
	const originalHome = process.env.HOME;
	const originalAgentDir = process.env.OCTOCODE_CODING_AGENT_DIR;
	const originalPermission = process.env.OCTOCODE_PERMISSION;
	process.env.HOME = home; // keep the developer's own config out of the test
	process.env.OCTOCODE_CODING_AGENT_DIR = agentDir; // and their Octocode settings
	// Sessions start in manual, and a headless one denies every ask: this user exported workspace.
	process.env.OCTOCODE_PERMISSION = "workspace";
	// Octocode's built-in MCP reads the user-level mcp.json; an `octocode` entry there overrides Octocode's registration.
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers }));
	const turns: Turn[] = [];
	const models = options.models ?? [{ id: "faux-1", inputCost: 0, maxTokens: 4_096 }];
	const faux = createFauxCore({
		provider: "faux",
		models: models.map(({ id, maxTokens }) => ({ id, contextWindow: 200_000, maxTokens })),
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model, index) => ({
				...model,
				promptCache: { short: 300, long: 3600 },
				cost: { input: models[index].inputCost, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		...options.settings,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: path.join(root, "agent"),
		settingsManager,
		extensionFactories: [{ name: "faux-provider", factory: provider }],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir: path.join(root, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		...(options.legacyTools
			? {
					customTools: [createReadToolDefinition(cwd)] as unknown as ToolDefinition[],
				}
			: {}),
		...(options.tools ? { tools: options.tools } : {}),
	});
	await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
	await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
	const run = async (prompt: string, replies: Array<(turn: Turn) => Reply>) => {
		faux.setResponses(
			replies.map((reply) => (context: TranscriptContext) => {
				const turn = snapshot(context);
				turns.push(turn);
				return reply(turn);
			}),
		);
		await session.prompt(prompt);
		return turns;
	};
	const dispose = async () => {
		await session.dispose?.();
		process.env.HOME = originalHome;
		if (originalAgentDir === undefined) delete process.env.OCTOCODE_CODING_AGENT_DIR;
		else process.env.OCTOCODE_CODING_AGENT_DIR = originalAgentDir;
		if (originalPermission === undefined) delete process.env.OCTOCODE_PERMISSION;
		else process.env.OCTOCODE_PERMISSION = originalPermission;
		// A child process or the MCP server may still be writing as the session closes: retry the removal.
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	};
	return { cwd, session, faux, run, dispose };
}

/** An mcp.json `octocode` entry that keeps the server off (a file entry wins over Octocode's registration). */
const OCTOCODE_OFF = { octocode: { command: "false", enabled: false } };

const calls =
	(...toolCalls: ReturnType<typeof fauxToolCall>[]) =>
	() =>
		fauxAssistantMessage(toolCalls, { stopReason: "toolUse" });
const say = (text: string) => () => fauxAssistantMessage(text);

describe("with Octocode MCP (default)", () => {
	let s: Awaited<ReturnType<typeof startSession>>;
	beforeAll(async () => {
		s = await startSession({});
		fs.writeFileSync(path.join(s.cwd, "app.ts"), "export const answer = 41;\n");
		fs.writeFileSync(path.join(s.cwd, "unread.txt"), "never read\n");
	}, 60_000);
	afterAll(() => s.dispose());

	it("exposes MCP tools and Octocode guidance from the first request", async () => {
		const turn = (await s.run("hello", [say("ready")])).at(-1)!;
		// Real Octocode + the local MCP, before provider-specific encoding. Project context and user skills are disabled here.
		// The separate prompt-size test guards only extension-owned prose/schemas, not this complete fixture prefix.
		// Two parts: Octocode's own text (system prompt without the server-provided text inside each `<mcp>` block, plus
		// the non-MCP tool contracts; the section's wrapper and the `<mcp>` tags stay ours) is capped. The MCP servers'
		// text (block contents plus `mcp__` tool contracts) is external: it is reported and never capped or trimmed.
		const serverBlock = /(<mcp name="[^"]*" tools="[^"]*">\n)[\s\S]*?(\n<\/mcp>)/g;
		const blocks = [...turn.systemPrompt.matchAll(serverBlock)];
		// Every server header must close: an unmatched block would move server text into our count, or the reverse.
		expect(blocks).toHaveLength(turn.systemPrompt.match(/<mcp name="/g)?.length ?? 0);
		const serverPromptChars = blocks.reduce(
			(sum, match) => sum + match[0].length - match[1].length - match[2].length,
			0,
		);
		const contractChars = (mcp: boolean) =>
			JSON.stringify(turn.toolContracts.filter((tool) => tool.name.startsWith("mcp__") === mcp)).length;
		const ownChars = turn.systemPrompt.length - serverPromptChars + contractChars(false);
		const mcpChars = serverPromptChars + contractChars(true);
		console.log(
			`default Octocode prefix: own ${ownChars} chars, MCP server text ${mcpChars} chars (prompt ${turn.systemPrompt.length}, ${turn.tools.length} tools)`,
		);
		// 75_300 (2026-10-31, measured 74,790; B338/B340/B343/B344): native tool text re-authored, `<tools>`/`<mcps>` from one
		// section registry, the flat `agent` tool and the `models` tool. 79_500 (2026-10-31, measured 78,252; B327): down from 88_300 (measured 88,140) after re-authoring the stale
		// `octocode-mcp` preset overrides (a drift test now fails when the linked server changes them), sharing docs and types
		// in the contract renderer, ollama opt-in and same-fact duplicates removed from policy and
		// tool text. The prefix includes the `mcps` section, so a stale override (raw server text) or a
		// longer catalog in the sibling repository moves it: 88_300 had absorbed about 1,800 of such growth and the `task`
		// tool; before that, 93,097 and 98,493 while the renderer kept full schemas (B322).
		// 75_000 (2026-10-31, measured 74,765; B366): the sibling server's catalog had changed, so every preset override was stale
		// and the raw contract made 82,523. The overrides were rewritten (prose -46%), and `agent` shows one line per type.
		// 88_000 (2026-11-03, measured 86,642; B6): every Octocode tool contract is resident (no cold-start index), by decision.
		// 88_000 (2026-11-03) was the cap on the whole prefix. 92,668 on 2026-11-04 came from the external Octocode MCP text
		// growing (M14: never trim it to fit a ceiling), so the cap now covers only our own text.
		// 43_100 (2026-11-04, own 42,457 of 92,668; MCP server text 50,212, uncapped and logged): the 88_000 headroom over
		// 86,642 (about 1.6%), applied to our own text.
		// 45_700 (2026-11-05, B55): the bash description's CLI guide with the probed host, requested by the user, measured
		// +2,569 chars (42,919 -> 45,488 in the same run setup).
		// 46_100 (2026-11-05, B59): the octocode CLI research line, fallback clause and CLI-guide Scope clause, requested by
		// the user, measured +410 in main; the rest from concurrent B60/B61 edits.
		// 48_700 (2026-11-06, measured 48,667): the same user-requested growth `prompt-size.test.ts` itemizes for main:
		// B150 `reason` rule +96, B156 backlog `updates` batch +1,508, B157 close instead of delete +about 820, B29 the agent
		// tool's `mcp` field +302 (+2,726 in all).
		// 49_723 (2026-11-06, measured 49,690; B170): the timer tool's closed `until` list, +953 in main (see
		// `prompt-size.test.ts`); the other +70 since 48,667 came from concurrent edits. Slack over the measurement is 33.
		// 50_047 (2026-11-07, measured 50,014; B218/B219, user-requested): the agent tool's `tasks` and the backlog's `items`
		// arrays, +303 in main (see `prompt-size.test.ts`); the other +21 since 49,690 came from concurrent edits.
		expect(ownChars, "Octocode's own prompt text and tool declarations grew beyond their headroom").toBeLessThan(
			50_047,
		);
		expect(turn.tools).toContain("file");
		expect(turn.tools).not.toContain("read");
		expect(turn.tools).toContain("mcp__octocode__localFetch");
		expect(turn.tools).toContain("mcp__octocode__localSearch");
		for (const name of ["edit", "write"]) expect(turn.tools).not.toContain(name);
		expect(turn.systemPrompt).toContain("<work>");
		// Every tool the server lists, GitHub and package registry ones included, is declared from the first request.
		for (const name of [
			"ghSearchRepo",
			"ghSearchCode",
			"ghStructure",
			"ghGetFileContent",
			"ghSearchHistory",
			"ghGetHistoryItem",
			"artifactSearch",
			"localSearch",
			"structureSearch",
			"astSearch",
			"localFetch",
			"lspSearch",
		])
			expect(turn.tools).toContain(`mcp__octocode__${name}`);
		expect(turn.tools).not.toContain("tool_search");
		// The extension's client connects before the first request is built, so the guidance and the server's contract
		// section (its instructions and typed tools) are there from the start, unchanged on the next request.
		// The research section routes code search to the server, and the bash search rule is left out.
		expect(turn.systemPrompt).toContain("use the research tools (`mcp__octocode__*`)");
		expect(turn.systemPrompt).toContain("descriptions route each question");
		expect(turn.systemPrompt).not.toContain("Search with bash");
		expect(turn.systemPrompt).toMatch(/<mcps>\n[^\n]*\n<mcp name="octocode" tools="mcp__octocode__\*">\n\S/);
		// Declared mode: the block is the server's instructions; the tools carry their own description and full schema.
		expect(turn.systemPrompt).not.toContain("declare namespace");
		const declared = turn.toolContracts.find((tool) => tool.name === "mcp__octocode__localSearch");
		expect(JSON.stringify(declared?.parameters)).toContain('"matchString"');
		// `<tools>` lists native tools one by one and each described server once by its purpose (stated there, not in
		// its `<mcps>` block); the server's tools are in `<mcps>`.
		const toolLines = /<tools>\n([^]*?)\n<\/tools>/.exec(turn.systemPrompt)?.[1].split("\n") ?? [];
		expect(toolLines.length).toBeGreaterThan(0);
		expect(toolLines.every((line) => /^- [\w-]+(?:__\*)?: \S/.test(line))).toBe(true);
		expect(toolLines).toContain(
			"- mcp__octocode__*: Code search and read; each tool's description says when to use it.",
		);
		for (const name of turn.tools.filter((tool) => !tool.startsWith("mcp__")))
			expect(
				toolLines.some((line) => line.startsWith(`- ${name}: `)),
				`<tools> lists ${name}`,
			).toBe(true);
		const next = (await s.run("continue", [say("ready")])).at(-1)!;
		expect(next.tools).toContain("mcp__octocode__localSearch");
		expect(next.systemPrompt).toBe(turn.systemPrompt);
		expect(next.toolContracts).toEqual(turn.toolContracts);
	}, 60_000);

	it("records passive team notices during streaming without an extra model request", async () => {
		const mail = new Mail({ sendMessage: s.session.sendCustomMessage.bind(s.session) });
		let requests = 0;
		const unsubscribe = s.session.agent.subscribe((event) => {
			if (event.type === "turn_start") requests++;
		});
		try {
			await s.run("finish this step", [
				() => {
					expect(mail.notice("passive notice: earlier mail was not delivered")).toBe(true);
					return fauxAssistantMessage("done");
				},
			]);
		} finally {
			unsubscribe();
		}
		expect(requests).toBe(1);
		expect(JSON.stringify(s.session.sessionManager.getBranch())).toContain(
			"passive notice: earlier mail was not delivered",
		);
	});

	it("reads through localFetch, then edits, writes and deletes with batched file calls", async () => {
		const appPath = path.join(s.cwd, "app.ts");
		const turns = await s.run("fix the answer", [
			calls(fauxToolCall("mcp__octocode__localFetch", { queries: [{ path: appPath }] })),
			calls(
				nativeCall("file", {
					reason: "Fix the answer and add notes",
					queries: [
						{
							reason: "answer is off by one",
							type: "edit",
							path: "app.ts",
							edits: [{ oldText: "41", newText: "42" }],
						},
						{ reason: "document the constant", type: "write", path: "NOTES.md", content: "# Notes\n" },
						{ reason: "replace a whole file", type: "write", path: "unread.txt", content: "replaced" },
					],
				}),
			),
			calls(
				nativeCall("file", {
					reason: "Remove the notes",
					queries: [{ reason: "no longer needed", type: "delete", path: "NOTES.md" }],
				}),
			),
			say("done"),
		]);
		const [afterRead, afterBatch, afterDelete] = turns.slice(-3);
		expect(afterRead.lastResults[0].text).toContain("export const answer = 41");
		const batch = afterBatch.lastResults[0];
		expect(batch.isError).toBe(false);
		expect(batch.text).toMatch(/1\. OK edit app\.ts/);
		expect(batch.text).toMatch(/2\. OK write NOTES\.md/);
		// An existing file never read in this session is refused; the rest of the batch still applies.
		expect(batch.text).toMatch(
			/3\. FAILED write unread\.txt: unread\.txt already exists and was not read in this session/,
		);
		expect(afterDelete.lastResults[0].text).toMatch(/OK delete NOTES\.md/);
		expect(fs.readFileSync(appPath, "utf8")).toBe("export const answer = 42;\n");
		expect(fs.readFileSync(path.join(s.cwd, "unread.txt"), "utf8")).toBe("never read\n");
		expect(fs.existsSync(path.join(s.cwd, "NOTES.md"))).toBe(false);
	}, 60_000);

	it("refuses to edit a file that changed on disk after it was read", async () => {
		const appPath = path.join(s.cwd, "app.ts");
		const turns = await s.run("edit again", [
			() => {
				fs.writeFileSync(appPath, "export const answer = 7;\n"); // someone else edits the file
				return fauxAssistantMessage(
					[
						nativeCall("file", {
							reason: "Bump the answer",
							queries: [{ reason: "bump", type: "edit", path: "app.ts", edits: [{ oldText: "42", newText: "43" }] }],
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			say("done"),
		]);
		const result = turns.at(-1)!.lastResults[0];
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/changed on disk since you last read it/);
	}, 60_000);

	it("accepts a localFetch read as evidence for a subsequent guarded change", async () => {
		const seen = path.join(s.cwd, "seen.ts");
		fs.writeFileSync(seen, "export const seen = 1;\n");
		const turns = await s.run("read then edit", [
			calls(fauxToolCall("mcp__octocode__localFetch", { queries: [{ path: seen }] })),
			calls(
				nativeCall("file", {
					reason: "Bump the seen value",
					queries: [
						{
							reason: "bump",
							type: "edit",
							path: "seen.ts",
							edits: [{ oldText: "seen = 1", newText: "seen = 2" }],
						},
					],
				}),
			),
			say("done"),
		]);
		const [afterRead, afterEdit] = turns.slice(-2);
		expect(afterRead.lastResults[0].text).toContain("export const seen = 1;");
		expect(afterEdit.lastResults[0].text).toMatch(/OK edit seen\.ts/);
		expect(fs.readFileSync(seen, "utf8")).toBe("export const seen = 2;\n");
	}, 60_000);

	// The server leaves a row's `path` out when it repeats the request's: a relative read still names its file.
	it("credits a relative-path localFetch read, whole or by range, for later changes", async () => {
		const whole = path.join(s.cwd, "relative.ts");
		const ranged = path.join(s.cwd, "ranged.ts");
		fs.writeFileSync(whole, "export const relative = 1;\n");
		fs.writeFileSync(ranged, "one\ntwo\nthree\nfour\n");
		const change = (query: Record<string, unknown>) =>
			calls(nativeCall("file", { reason: "Change a read file", queries: [{ reason: "change", ...query }] }));
		const turns = await s.run("read relative paths then change them", [
			calls(
				fauxToolCall("mcp__octocode__localFetch", {
					queries: [{ path: "relative.ts" }, { path: "ranged.ts", ranges: [{ startLine: 2, endLine: 3 }] }],
				}),
			),
			change({ type: "edit", path: "relative.ts", edits: [{ oldText: "relative = 1", newText: "relative = 2" }] }),
			change({ type: "edit", path: "ranged.ts", edits: [{ oldText: "two", newText: "TWO" }] }),
			// The range counts as the lines it showed, not the whole file: a full write is still refused.
			change({ type: "write", path: "ranged.ts", content: "replaced\n" }),
			say("done"),
		]);
		const [afterRead, afterWhole, afterRanged, afterWrite] = turns.slice(-4);
		expect(afterRead.lastResults[0].isError).toBe(false);
		expect(afterWhole.lastResults[0].text).toMatch(/OK edit relative\.ts/);
		expect(afterRanged.lastResults[0].text).toMatch(/OK edit ranged\.ts/);
		expect(afterWrite.lastResults[0].text).toMatch(/ranged\.ts: a write replaces the whole file, but you have seen/);
		expect(fs.readFileSync(whole, "utf8")).toBe("export const relative = 2;\n");
		expect(fs.readFileSync(ranged, "utf8")).toBe("one\nTWO\nthree\nfour\n");
	}, 60_000);

	it("gives the model a page over 20 KB of UTF-8 whole, with no truncation marker", async () => {
		// The server measures a page by its serialized JSON size: at its default 20,000 budget this non-ASCII page comes
		// to about 10,000 characters and just under 20 KB of UTF-8. A 40,000 budget makes one page well over 20 KB, which
		// must reach the model whole: nothing on Octocode's side trims an MCP result to 20 KB.
		const files = ["one", "two"].map((name) => {
			const file = path.join(s.cwd, `${name}.ts`);
			fs.writeFileSync(
				file,
				Array.from(
					{ length: 3_000 },
					(_, index) => `export const ${name}${index} = '${"日本語のテキスト".repeat(4)}';\n`,
				).join(""),
			);
			return file;
		});
		const turns = await s.run("read both", [
			calls(
				fauxToolCall("mcp__octocode__localFetch", {
					queries: files.map((file) => ({ path: file, ranges: [{ startLine: 1, endLine: 600 }] })),
					responseChars: 40_000,
				}),
			),
			say("done"),
		]);
		const text = turns.at(-1)!.lastResults[0].text;
		expect(Buffer.byteLength(text)).toBeGreaterThan(20 * 1024);
		expect(text).not.toMatch(/truncated|trimmed|fullOutputPath|pi-mcp/i);
		// The server's JSON answer arrives whole: it still parses, and both files' first lines are in it. How the server
		// shapes its rows and cursors is its own contract (M22), tested in its repository.
		expect(() => JSON.parse(text)).not.toThrow();
		for (const name of ["one", "two"]) expect(text).toContain(`export const ${name}0 = `);
	}, 60_000);
});

describe("with the user's own octocode server in mcp.json", () => {
	let s: Awaited<ReturnType<typeof startSession>>;
	beforeAll(async () => {
		// The user's entry owns `octocode`: Octocode runs it, and the extension starts and registers nothing of its own.
		s = await startSession({ octocode: { command: process.execPath, args: [FIXTURE], exposure: "direct" } });
	}, 60_000);
	afterAll(() => s.dispose());

	it("leaves the server to Octocode, follows its tools in the prompt, and round-trips a call", async () => {
		const turns = await s.run("use it", [calls(fauxToolCall("mcp__octocode__shout", { text: "hi" })), say("done")]);
		const first = turns.at(-2)!;
		expect(first.tools).toContain("mcp__octocode__shout");
		expect(first.tools).not.toContain("mcp__octocode__localSearch");
		// The prompt follows the tools by server name (`turn.ts`: `isOctocodeTool`), so the user's own `octocode` entry still
		// counts as the research server: it gets the routing line and no native fallback. The same-named entry inherits the
		// default entry's roles (`packages/mcp/src/config.ts`), so that line names the default server's search tools even
		// though this server does not offer them.
		expect(first.systemPrompt).toContain("use the research tools (`mcp__octocode__*`)");
		expect(first.systemPrompt).toContain("search with `localSearch`, `structureSearch`, `astSearch` or `lspSearch`");
		expect(first.systemPrompt).not.toContain("Search with bash");
		expect(first.systemPrompt).not.toContain("# Octocode MCP server instructions");
		expect(turns.at(-1)!.lastResults[0]).toEqual({
			toolName: "mcp__octocode__shout",
			isError: false,
			text: expect.stringMatching(UNTRUSTED("mcp__octocode__shout", "HI")),
		});
	});
});

describe("with another MCP server and Octocode disabled", () => {
	let s: Awaited<ReturnType<typeof startSession>>;
	beforeAll(async () => {
		s = await startSession(
			{
				...OCTOCODE_OFF,
				echo: { command: process.execPath, args: [FIXTURE], exposure: "direct" },
			},
			{ legacyTools: true },
		);
	}, 60_000);
	afterAll(() => s.dispose());

	it("keeps Octocode read, leaves MCP to Octocode, and drops the Octocode research line", async () => {
		const turn = (await s.run("hello", [say("ready")])).at(-1)!;
		for (const name of ["read", "file", "bash", "web", "agent", "askUser", "backlog", "archive", "mcp__echo__shout"])
			expect(turn.tools).toContain(name);
		// `steps` is registered but not in the default list.
		expect(turn.tools).not.toContain("steps");
		// The native `mcp` tool is always selected where MCP is allowed, so it stays with only another server connected.
		expect(turn.tools).toContain("mcp");
		expect(turn.tools.some((name) => name.startsWith("mcp__octocode__"))).toBe(false);
		// The mcp.json entry replaces the registration, so there is no research server: the bash search fallback shows.
		const fallback = "Search with bash";
		expect(turn.systemPrompt).not.toContain("use the research tools");
		expect(turn.systemPrompt).toContain(fallback);
		const next = (await s.run("again", [say("ok")])).at(-1)!;
		expect(next.systemPrompt).not.toContain("use the research tools");
		expect(next.systemPrompt).toContain(fallback);
	});

	it("calls another server's tools through Octocode's MCP, surfacing remote errors", async () => {
		const turns = await s.run("use echo", [
			calls(fauxToolCall("mcp__echo__shout", { text: "hi" }), fauxToolCall("mcp__echo__fail", {})),
			say("done"),
		]);
		const [ok, failed] = turns.at(-1)!.lastResults;
		expect(ok).toEqual({
			toolName: "mcp__echo__shout",
			isError: false,
			text: expect.stringMatching(UNTRUSTED("mcp__echo__shout", "HI")),
		});
		expect(failed.isError).toBe(true);
		expect(failed.text).toContain("boom");
	});

	it("writes new files, refuses an unread existing one, and a read then write works", async () => {
		fs.writeFileSync(path.join(s.cwd, "existing.txt"), "original\n");
		const turns = await s.run("write files", [
			calls(
				nativeCall("file", {
					reason: "Write the files",
					queries: [
						{ reason: "new", type: "write", path: "new.txt", content: "fresh" },
						{ reason: "clobber", type: "write", path: "existing.txt", content: "x" },
					],
				}),
			),
			calls(fauxToolCall("read", { path: "existing.txt" })),
			calls(
				nativeCall("file", {
					reason: "Replace the file",
					queries: [{ reason: "replace", type: "write", path: "existing.txt", content: "replaced" }],
				}),
			),
			say("done"),
		]);
		const [writes, , rewrite] = turns.slice(-3);
		expect(writes.lastResults[0].text).toMatch(
			/1\. OK write new\.txt[\s\S]*2\. FAILED write existing\.txt: existing\.txt already exists and was not read/,
		);
		expect(rewrite.lastResults[0].text).toMatch(/OK write existing\.txt/);
		expect(fs.readFileSync(path.join(s.cwd, "existing.txt"), "utf8")).toBe("replaced");
	});

	it("answers a repeated read of an unchanged file with a note, and the file can still be rewritten after it", async () => {
		fs.writeFileSync(path.join(s.cwd, "twice.txt"), "same line\n".repeat(200));
		const turns = await s.run("read twice", [
			calls(fauxToolCall("read", { path: "twice.txt" })),
			calls(fauxToolCall("read", { path: "twice.txt" })),
			calls(
				nativeCall("file", {
					reason: "Replace the file",
					queries: [{ reason: "replace", type: "write", path: "twice.txt", content: "replaced" }],
				}),
			),
			say("done"),
		]);
		const [first, second, rewrite] = turns.slice(-3);
		expect(first.lastResults[0].text).toContain("same line");
		expect(second.lastResults[0].text).toMatch(/^\[Unchanged since your earlier read of twice\.txt \(same range\)/);
		expect(rewrite.lastResults[0].text).toMatch(/OK write twice\.txt/);
	});

	it("clears old results at request time once the cache is cold inside a run, to saved files and without any context edit", async () => {
		// One assistant message's tool text is bounded to `TURN_MAX_CHARS` (`turn-budget.ts`), so the 22 reads come as two messages.
		const read = (index: number) => {
			const file = `big-${index}.txt`;
			fs.writeFileSync(path.join(s.cwd, file), "line of text\n".repeat(540));
			return fauxToolCall("read", { path: file });
		};
		const realNow = Date.now.bind(Date);
		// The tools ran longer than the prompt-cache lifetime: the next request would rewrite the cache anyway.
		const later = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * 60_000 + 1);
		const cold = (from: number) => () =>
			fauxAssistantMessage(
				Array.from({ length: 11 }, (_, offset) => read(from + offset)),
				{
					stopReason: "toolUse",
					timestamp: realNow(),
				},
			);
		const results = await s
			.run("read a lot", [cold(0), cold(11), say("done")])
			.finally(() => later.mockRestore())
			// The session keeps earlier tests' results: this run's are the newest 22.
			.then((turns) => turns.at(-1)!.allResults.slice(-22));
		expect(results).toHaveLength(22);
		const cleared = results.filter((result) => result.text.startsWith("[Old tool result cleared"));
		// The newest five stay whole; every older one is a placeholder that names the file holding its whole text.
		expect(cleared).toHaveLength(17);
		expect(results.slice(-5).every((result) => result.text.length > 7_000)).toBe(true);
		expect(results.slice(-5).some((result) => result.text.startsWith("[Omitted"))).toBe(false);
		for (const result of cleared) expect(result.text).toMatch(/Full output: \S+ \(sha256/);
		const entries = s.session.sessionManager.getEntries();
		expect(entries.filter((entry) => entry.type === "context_edit")).toHaveLength(0);
		expect(
			entries.filter((entry) => entry.type === "custom" && entry.customType === "octocode-cleared-results"),
		).toHaveLength(1);
	});

	it("reports unavailable askUser without inventing an answer or approval", async () => {
		const question = {
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A (Recommended)", description: "a" },
				{ label: "B", description: "b" },
			],
		};
		const turns = await s.run("ask", [calls(nativeCall("askUser", { questions: [question] })), say("done")]);
		expect(turns.at(-1)!.lastResults[0].text).toMatch(/No interactive user/);
		expect(turns.at(-1)!.lastResults[0].text).toContain("No answer or approval was supplied.");
	});
});

describe("compaction", () => {
	let s: Awaited<ReturnType<typeof startSession>>;
	const compactionEntries = () =>
		s.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction") as Array<{
			fromHook?: boolean;
			summary: string;
			details?: Record<string, unknown>;
		}>;
	/** Answers every summary request, recording the model and prompt text of each. */
	const script = (reply: string) => {
		const log: Array<{ model: string; text: string }> = [];
		s.faux.setResponses(
			Array.from(
				{ length: 10 },
				() => (context: TranscriptContext, _options: unknown, _state: unknown, model: { id: string }) => {
					log.push({ model: model.id, text: JSON.stringify(context.messages) });
					return fauxAssistantMessage(reply);
				},
			),
		);
		return log;
	};

	beforeAll(async () => {
		s = await startSession(OCTOCODE_OFF, {
			legacyTools: true,
			// A priced session model plus a cheaper small-tier one: compaction must stay on the session model.
			models: [
				{ id: "faux-1", inputCost: 3, maxTokens: 32_000 },
				{ id: "faux-haiku", inputCost: 1, maxTokens: 16_000 },
			],
			// Exceed the fixed 20,000-token retained tail; legacy compaction settings are ignored.
		});
	}, 60_000);
	afterAll(() => s.dispose());

	it("summarizes on the user's model with Octocode's handoff sections, listing files the file tool changed", async () => {
		fs.writeFileSync(path.join(s.cwd, "notes.txt"), "hello\n");
		await s.run("Please read notes.txt and create todo.txt", [
			calls(fauxToolCall("read", { path: "notes.txt" })),
			calls(
				nativeCall("file", {
					reason: "Create the todo",
					queries: [{ reason: "create", type: "write", path: "todo.txt", content: "x" }],
				}),
			),
			say(`Done. ${"detail ".repeat(14_000)}`),
		]);
		await s.run("Now keep going with the plan", [say(`More work. ${"detail ".repeat(14_000)}`)]);
		const log = script("## Goal\nOctocode summary");
		await s.session.compact();
		expect(log.length).toBeGreaterThan(0);
		expect(new Set(log.map((call) => call.model))).toEqual(new Set(["faux-1"]));
		expect(log.some((call) => call.text.includes("This summary becomes the only record"))).toBe(true);
		// Exact user constraints are kept as written, not paraphrased (code keeps whole messages only within its budget).
		expect(
			log.some((call) =>
				call.text.includes(
					"do not quote whole messages; state what they asked for, decided and corrected, and keep each limit, number, path, identifier and prohibition the user set exactly as written",
				),
			),
		).toBe(true);
		// The summary is asked for inside the session's own request (its messages, then one more), not as a standalone prompt.
		expect(log[0].text).toContain("Please read notes.txt and create todo.txt");
		expect(log[0].text).toContain("Stop here and write a context checkpoint");
		expect(log[0].text).not.toContain("<conversation>");
		// The handoff sections are `SUMMARY_CHECKPOINT_FORMAT` (`core/compaction/summary-format.ts`); "## TL;DR" replaced "## Follow-ups".
		for (const section of ["## Errors & Fixes", "## Where We Stopped", "## TL;DR", "only record"])
			expect(log.some((call) => call.text.includes(section))).toBe(true);
		const entry = compactionEntries().at(-1)!;
		expect(entry.fromHook).toBe(true);
		expect(entry.details).toMatchObject({ readFiles: ["notes.txt"], modifiedFiles: ["todo.txt"] });
		expect(entry.summary).toContain("Octocode summary");
		expect(entry.summary).toMatch(
			/<read-files>\nnotes\.txt\n<\/read-files>[\s\S]*<modified-files>\ntodo\.txt\n<\/modified-files>/,
		);
		// Code, not the model, keeps the user's own words, oldest first.
		expect(entry.summary).toMatch(
			/## User Messages \(verbatim, oldest first\)\n<user-message>\nPlease read notes\.txt and create todo\.txt\n<\/user-message>\n<user-message>\nNow keep going with the plan\n<\/user-message>/,
		);
	}, 60_000);

	it("reads the files worked on back into the context after compaction, so they can be changed without a fresh read", async () => {
		const turns = await s.run("overwrite", [
			calls(
				nativeCall("file", {
					reason: "Replace the notes",
					queries: [{ reason: "replace", type: "write", path: "notes.txt", content: "x" }],
				}),
			),
			say("done"),
		]);
		expect(turns.at(-1)!.lastResults[0].text).toMatch(/OK write notes\.txt/);
		const restored = s.session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					(entry as { customType?: string }).customType === "octocode-restored-files",
			) as Array<{ content: string; details: { files: string[] } }>;
		expect(restored).toHaveLength(1);
		expect(restored[0].content).toMatch(/<file path="todo\.txt">\nx\n<\/file>/);
		expect(restored[0].content).toMatch(/<file path="notes\.txt">\nhello\n<\/file>/);
	}, 60_000);

	it("carries file lists forward through the next compaction, and puts the summary first in the next request", async () => {
		await s.run("more", [say(`Even more. ${"detail ".repeat(14_000)}`)]);
		script("## Goal\nNext summary");
		await s.session.compact();
		expect(compactionEntries().at(-1)!.details!.modifiedFiles).toEqual(
			expect.arrayContaining(["todo.txt", "notes.txt"]),
		);
		const log: string[] = [];
		s.faux.setResponses([
			(context: TranscriptContext) => {
				const messages = context.messages.filter((message) => (message as { role: string }).role !== "system");
				log.push(JSON.stringify(messages[0]));
				return fauxAssistantMessage("ok");
			},
		]);
		await s.session.prompt("continue");
		expect(log[0]).toContain("Next summary");
	}, 60_000);

	it("falls back to Octocode's default summary when Octocode's fails", async () => {
		await s.run("more", [say(`Again. ${"detail ".repeat(14_000)}`)]);
		let calls = 0;
		s.faux.setResponses(
			Array.from({ length: 6 }, () => () => {
				calls += 1;
				// The cache-sharing request and Octocode's standalone one both fail; Octocode's own summary then answers.
				if (calls <= 2) throw new Error("summary provider down");
				return fauxAssistantMessage("## Goal\nDefault summary");
			}),
		);
		await s.session.compact();
		const entry = compactionEntries().at(-1)!;
		expect(entry.fromHook).not.toBe(true);
		expect(entry.summary).toContain("Default summary");
		expect(entry.details!.modifiedFiles).toEqual(expect.arrayContaining(["todo.txt"]));
		// What code appends to Octocode's summary follows the default one as one hidden message: the user's earlier messages
		// word for word (carried from the previous checkpoint) and the Recovery section, which names the archive itself.
		const custom = (type: string) =>
			s.session.sessionManager
				.getEntries()
				.filter(
					(item) => item.type === "custom_message" && (item as { customType?: string }).customType === type,
				) as Array<{ content: string }>;
		const continuity = custom("octocode-compaction-continuity");
		expect(continuity).toHaveLength(1);
		expect(custom("octocode-archive")).toHaveLength(0);
		const requests: string[] = [];
		s.faux.setResponses([
			(context: TranscriptContext) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("ok");
			},
		]);
		await s.session.prompt("continue after the fallback");
		expect(requests[0]).toContain("<user-message>\\nPlease read notes.txt and create todo.txt\\n</user-message>");
		expect(requests[0]).toContain("## Recovery\\n- ");
		// The next Octocode summary carries those messages once, from the continuity message, not a second copy.
		await s.run("later", [say(`Later. ${"detail ".repeat(14_000)}`)]);
		script("## Goal\nAfter fallback");
		await s.session.compact();
		const next = compactionEntries().at(-1)!.summary;
		expect(next.split("<user-message>\nPlease read notes.txt and create todo.txt\n</user-message>")).toHaveLength(2);
	}, 60_000);
});

describe("request too large (HTTP 413)", () => {
	let s: Awaited<ReturnType<typeof startSession>>;
	beforeAll(async () => {
		s = await startSession(OCTOCODE_OFF, { legacyTools: true });
		// A 1x1 PNG: Octocode's `read` returns it as an image part.
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		for (const name of ["a.png", "b.png", "c.png"]) fs.writeFileSync(path.join(s.cwd, name), png);
	}, 60_000);
	afterAll(() => s.dispose());

	it("strips older images and retries on its own when a gateway rejects the request with a bodiless 413", async () => {
		const images = (context: TranscriptContext) =>
			context.messages.reduce((sum, message) => {
				const content = (message as { content?: unknown }).content;
				return (
					sum + (Array.isArray(content) ? content.filter((part: { type?: string }) => part.type === "image").length : 0)
				);
			}, 0);
		const seen: number[] = [];
		// The gateway accepts at most one image per request.
		const gateway = (context: TranscriptContext, reply: Reply) => {
			seen.push(images(context));
			return images(context) > 1
				? fauxAssistantMessage([], { stopReason: "error", errorMessage: "gateway status code 413 (no body)" })
				: reply;
		};
		s.faux.setResponses([
			(context) =>
				gateway(
					context,
					fauxAssistantMessage(
						[
							fauxToolCall("read", { path: "a.png" }),
							fauxToolCall("read", { path: "b.png" }),
							fauxToolCall("read", { path: "c.png" }),
						],
						{ stopReason: "toolUse" },
					),
				),
			(context) => gateway(context, fauxAssistantMessage("rejected")),
			(context) => gateway(context, fauxAssistantMessage("looked at the newest image")),
		]);
		await s.session.prompt("look at the screenshots");
		// Request 2 carries three images and is rejected; the retry keeps only the newest and succeeds, without a new prompt.
		expect(seen).toEqual([0, 3, 1]);
		const last = s.session.messages.at(-1) as { role: string; content: Array<{ text?: string }> };
		expect(last.role).toBe("assistant");
		expect(last.content.map((part) => part.text).join("")).toBe("looked at the newest image");
	}, 60_000);
});

describe("a subagent session with MCP enabled", () => {
	let s: Awaited<ReturnType<typeof startSession>>;
	const previous = {
		sub: process.env.OCTOCODE_SUBAGENT,
		item: process.env.OCTOCODE_BACKLOG_ITEM,
	};

	beforeAll(async () => {
		process.env.OCTOCODE_SUBAGENT = "1";
		// A child declares `backlog` only when its task names an item (BACKLOG_ITEM_ENV).
		process.env.OCTOCODE_BACKLOG_ITEM = "B1";
		s = await startSession({}, {});
		fs.writeFileSync(path.join(s.cwd, "app.ts"), "export const answer = 41;\n");
	}, 200_000);

	afterAll(async () => {
		await s?.dispose();
		for (const [key, value] of [
			["OCTOCODE_SUBAGENT", previous.sub],
			["OCTOCODE_BACKLOG_ITEM", previous.item],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("has Octocode and browser tools and can call Octocode", async () => {
		const turn = (await s.run("hello", [say("ready")])).at(-1)!;
		expect(turn.tools).toContain("mcp__octocode__localFetch");
		expect(turn.tools).not.toContain("browser");
		expect(turn.tools.filter((name) => name.includes("cua"))).toEqual([]);
		expect(turn.tools).toContain("agent");
		expect(turn.tools).not.toContain("askUser");
		expect(turn.toolContracts.find((tool) => tool.name === "archive")?.parameters).toMatchObject({
			properties: { op: { enum: ["search", "get", "list"] } },
		});
		expect(turn.toolContracts.find((tool) => tool.name === "backlog")?.parameters).toMatchObject({
			properties: { op: { enum: ["list", "get", "add", "update"] } },
		});
		for (const name of ["agent", "backlog", "archive"]) expect(turn.tools).toContain(name);
		expect(turn.tools).not.toContain("steps");
		expect(turn.systemPrompt).toContain("You are a subagent");
		expect(turn.toolContracts.find((tool) => tool.name === "agent")?.parameters).toBeDefined();
		const appPath = path.join(s.cwd, "app.ts");
		const turns = await s.run("read", [
			calls(fauxToolCall("mcp__octocode__localFetch", { queries: [{ path: appPath }] })),
			say("done"),
		]);
		const results = turns.at(-1)!.lastResults;
		expect(results.find((result) => result.toolName === "mcp__octocode__localFetch")?.text).toContain("answer = 41");
	}, 60_000);

	it("credits a relative-path localFetch read for a later edit", async () => {
		const file = path.join(s.cwd, "child.ts");
		fs.writeFileSync(file, "export const child = 1;\n");
		const turns = await s.run("read then edit", [
			calls(fauxToolCall("mcp__octocode__localFetch", { queries: [{ path: "child.ts" }] })),
			calls(
				nativeCall("file", {
					reason: "Bump the child value",
					queries: [
						{
							reason: "bump",
							type: "edit",
							path: "child.ts",
							edits: [{ oldText: "child = 1", newText: "child = 2" }],
						},
					],
				}),
			),
			say("done"),
		]);
		expect(turns.at(-1)!.lastResults[0].text).toMatch(/OK edit child\.ts/);
		expect(fs.readFileSync(file, "utf8")).toBe("export const child = 2;\n");
	}, 60_000);
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
import type * as NativeConfig from "../../src/config.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { harnessToggles } from "./e2e-helpers/harness-toggles.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TEAM_ENTRY } from "../../src/octocode/team/session/rejoin.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { nativeCall } from "./e2e-calls.ts";
import { tmp } from "./helpers.ts";

/** Feature checks through the SDK defaults with a scripted model and isolated configuration. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const savedEnv = { ...process.env };
const savedArgv = process.argv[1];
const root = fs.realpathSync(tmp("octocode-features-"));
const cwd = path.join(root, "project");
const home = path.join(root, "home");
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface Turn {
	tools: string[];
	context: string;
	results: Array<{ toolName: string; isError: boolean; text: string }>;
}

function snapshot(context: TranscriptContext): Turn {
	const results: Turn["results"] = [];
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index] as {
			role: string;
			toolName?: string;
			isError?: boolean;
			content?: unknown;
		};
		if (message.role === "system") continue;
		if (message.role !== "toolResult") break;
		const text = Array.isArray(message.content)
			? message.content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";
		results.unshift({ toolName: String(message.toolName), isError: message.isError === true, text });
	}
	return {
		tools: getCurrentTools(context.messages).map((tool) => tool.name),
		context: `${getCurrentSystemPrompt(context.messages)}\n${JSON.stringify(context.messages)}`,
		results,
	};
}

const calls =
	(...toolCalls: ReturnType<typeof fauxToolCall>[]) =>
	() =>
		fauxAssistantMessage(toolCalls, { stopReason: "toolUse" });
/** The flat `agent` call: `type` and that type's fields at the top level. */
const agentCall = (type: "task" | "coordinate" | "message", fields: Parameters<typeof fauxToolCall>[1]) =>
	nativeCall("agent", { type, ...fields });
const say = (text: string) => () => fauxAssistantMessage(text);
type Reply = () => ReturnType<typeof fauxAssistantMessage>;

let session: Awaited<ReturnType<typeof createTestSession>>["session"];
let faux: ReturnType<typeof createFauxCore>;
const turns: Turn[] = [];
/** A run started and Octocode has not emitted its `agent_settled` yet: a prompt sent now is deferred until the run settles, and may never reach the model. */
let unsettled = false;
const ui = fakeCtx({ cwd: root }).ui;

/**
 * Waits until no turn runs or settles. A turn started earlier (a delivered team message or a background report wakes
 * one, and a reload can start another) makes `prompt` throw "Agent is already processing" while it runs, and Octocode defers
 * a prompt or command sent while it settles (`isStreaming` is already false then).
 */
const settled = () => vi.waitFor(() => expect(session.isStreaming || unsettled).toBe(false), { timeout: 10_000 });

async function run(prompt: string, replies: Reply[]): Promise<Turn[]> {
	const start = turns.length;
	await settled();
	faux.setResponses(
		replies.map((reply) => (context: TranscriptContext) => {
			turns.push(snapshot(context));
			return reply();
		}),
	);
	await session.prompt(prompt);
	return turns.slice(start);
}

const note = (pattern: RegExp) => ui.notes.find((entry) => pattern.test(entry.message))?.message;

beforeAll(async () => {
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(path.join(home, ".claude", "skills", "demo-skill"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", "skills", "demo-skill", "SKILL.md"),
		"---\nname: demo-skill\ndescription: Demo skill picked up from ~/.claude/skills.\n---\nBody.\n",
	);
	// Claude Code hooks: PreToolUse blocks bash mentioning "forbidden", PostToolUse annotates, SessionStart adds context.
	const hook = path.join(home, "hook.cjs");
	fs.writeFileSync(
		hook,
		`let input = ''; process.stdin.on('data', (c) => (input += c)).on('end', () => {
      const event = JSON.parse(input);
      if (event.hook_event_name === 'SessionStart') return console.log('hook says: project uses tabs');
      if (event.hook_event_name === 'PostToolUse') return console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: 'post hook saw ' + event.tool_name } }));
      if (JSON.stringify(event.tool_input).includes('forbidden')) { console.error('no forbidden words'); process.exit(2); }
    });`,
	);
	const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`;
	const entry = (matcher: string) => [{ matcher, hooks: [{ type: "command", command }] }];
	fs.writeFileSync(
		path.join(home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: { PreToolUse: entry("Bash"), PostToolUse: entry("Bash"), SessionStart: entry("startup") },
		}),
	);
	// A Octocode-protected resource, so Octocode resolves project trust without /trust.
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), "{}");
	fs.writeFileSync(path.join(cwd, "app.ts"), "export const answer = 41;\n");
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	git("add", "-A");
	git("commit", "-q", "-m", "init");

	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		HOME: home,
		OCTOCODE_CODING_AGENT_DIR: path.join(root, "agent"),
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
		OCTOCODE_MCP: "1",
		OCTOCODE_PERMISSION: "workspace",
	});
	// Subagents re-run the current `octocode` script: point it at the scripted stand-in.
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(path.join(HERE, "subagent-fake-host.cjs"), path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");

	faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }] as never,
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, toggles: harnessToggles("claude") });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: path.join(root, "agent"),
		settingsManager,
		extensionFactories: [{ name: "faux-provider", factory: provider }],
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	({ session } = await createTestSession({
		cwd,
		agentDir: path.join(root, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	}));
	session.subscribe((event) => {
		if (event.type === "agent_start") unsettled = true;
		else if (event.type === "agent_settled") unsettled = false;
	});
	await session.bindExtensions({ uiContext: ui, mode: "rpc", shutdownHandler: () => undefined } as never);
	await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
}, 60_000);

afterAll(async () => {
	await session?.dispose?.();
	process.env = savedEnv;
	process.argv[1] = savedArgv!;
});

describe("Native features through the SDK", () => {
	it("registers every tool and command, keeps the banner out of the session and picks up ~/.claude skills", async () => {
		const [turn] = await run("hello", [say("ready")]);
		for (const name of ["file", "bash", "web", "agent", "askUser", "backlog", "archive"])
			expect(turn.tools).toContain(name);
		// Browsing is the browser MCP server's; no native `browser` tool is registered.
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("browser");
		const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.name);
		for (const name of [
			"status",
			"agents",
			"harness",
			"resume",
			"permissions",
			"backlog",
			"memory",
			"rewind",
			"api",
			"mcp",
			// `/web` opens the live workspace (`remote/register.ts`); `/octocode` runs the research CLI (`cli/command.ts`).
			"web",
			"octocode",
		])
			expect(commands).toContain(name);
		expect(commands.filter((name) => name === "mcp")).toHaveLength(1);
		// Folded into /harness: one name per command.
		for (const retired of ["plugins", "hooks", "config"]) expect(commands).not.toContain(retired);
		expect(session.systemPrompt).toContain("demo-skill");
		expect(turn.context).toContain("<delegation>");
		// The banner is the TUI header (none over RPC), never a session entry. The only custom entry is the team name
		// a top-level session records when it joins at start (`team/session/membership.ts` joinAtStart, design B36 O6).
		const custom = session.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" ? [entry.customType] : []));
		expect(custom.filter((type) => type !== TEAM_ENTRY)).toEqual([]);
		expect((ui as { header?: unknown }).header).toBeUndefined();
		expect((ui as { title?: string }).title).toBeUndefined();
		// SessionStart hook output reaches the model once, as data.
		expect(turn.context).toContain("hook says: project uses tabs");
	});

	it("runs direct native commands and the research CLI without a model call", async () => {
		await session.prompt("/status");
		// `/status` lists each MCP server's connection state (`status-command.ts`), not an `Octocode MCP:` summary line.
		expect(note(/^Octocode \d/)).toMatch(/^MCPs \(\d+\)\n(?:.*\n)*? {2}octocode: connected;/m);
		expect(note(/^Octocode \d/)).toMatch(/Subagents: .*researcher/);
		expect(note(/^Octocode \d/)).toMatch(/^Skills \([1-9]\d*\)$/m);
		expect(note(/^Octocode \d/)).toMatch(/Hooks: (off|on)/);
		await session.prompt("/harness hooks");
		expect(note(/^Hooks: /)).toMatch(/Hook files[\s\S]*settings\.json/);
		const beforeRequests = turns.length;
		// `/octocode` passes its arguments to the research CLI verbatim and never reaches the model; without a terminal the
		// CLI's own output is the result, a warning when it exits with an error. No case here may sign in for real.
		await session.prompt("/octocode --version");
		expect(ui.notes.at(-1)).toMatchObject({ message: expect.stringMatching(/^octocode \d+\.\d+\.\d+$/), type: "info" });
		await session.prompt("/octocode no-such-subcommand");
		expect(ui.notes.at(-1)).toMatchObject({ message: expect.stringContaining("no-such-subcommand"), type: "warning" });
		expect(turns).toHaveLength(beforeRequests);
		await session.prompt("/agents");
		// A mode change reaches the model as one hidden message, never through the cached system prompt.
		const prompt = session.systemPrompt;
		await session.prompt("/permissions manual");
		expect(session.systemPrompt).toBe(prompt);
		await session.prompt("/permissions");
		expect(note(/^Permission mode: manual —/)).toMatch(/not a sandbox/);
		await session.prompt("/permissions workspace");
		const notes = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "octocode-permission");
		expect(notes.length).toBeGreaterThan(0);
		expect(notes.every((entry) => entry.type === "custom_message" && !entry.display)).toBe(true);
		expect(session.systemPrompt).toBe(prompt);
	});

	it("guards bash: a destructive command asks, a hook-blocked command is refused, hooks annotate results", async () => {
		ui.selects.push("Deny");
		const destructive = "rm -rf ~/.ssh/disposable-delete-target";
		const [, second] = await run("bash", [
			calls(
				nativeCall("bash", { command: destructive }),
				nativeCall("bash", { command: "echo forbidden" }),
				nativeCall("bash", { command: "echo fine" }),
			),
			say("done"),
		]);
		const [danger, blocked, fine] = second.results;
		expect(danger).toMatchObject({ isError: true });
		expect(danger.text).toContain(`The user denied the destructive shell command: ${destructive}`);
		expect(blocked).toMatchObject({ isError: true });
		expect(blocked.text).toMatch(/PreToolUse hook: no forbidden words/);
		expect(fine.text).toMatch(/fine[\s\S]*\[PostToolUse hook\] post hook saw Bash/);
	});

	it("replaces Octocode bash: a deadline in its schema, and a background job wakes the session with its result", async () => {
		expect(JSON.stringify(session.getAllTools().find((tool) => tool.name === "bash")?.parameters)).toContain(
			"foreground default 900s",
		);
		const start = turns.length;
		await run("bash in the background", [
			calls(nativeCall("bash", { command: "echo bg-output", background: true })),
			say("started"),
			say("saw it"),
		]);
		const deadline = Date.now() + 5_000;
		while (turns.length < start + 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		const [, started, woken] = turns.slice(start);
		expect(started.results[0].text).toMatch(/^Started bash-\d+ in the background/);
		expect(woken.context).toMatch(/Background bash bash-\d+ finished after \d+s: echo bg-output[\s\S]*bg-output/);
	});

	it("asks before web fetches a loopback URL, and fetches nothing when denied", async () => {
		ui.selects.push("Deny");
		const [, second] = await run("web", [calls(nativeCall("web", { url: "http://127.0.0.1:9/secret" })), say("done")]);
		expect(second.results[0]).toMatchObject({ toolName: "web", isError: true });
		expect(second.results[0].text).toMatch(
			/The user denied opening a private or local address: http:\/\/127\.0\.0\.1:9\/secret/,
		);
	});

	it("rejects ambiguous web requests through Octocode instead of choosing one operation", async () => {
		const [, second] = await run("web", [
			calls(nativeCall("web", { url: "https://example.com", query: "example" })),
			say("done"),
		]);
		expect(second.results[0]).toMatchObject({ toolName: "web", isError: true });
		expect(second.results[0].text).toContain("Provide exactly one of url or query.");
	});

	it("checkpoints file changes and /rewind restores them", async () => {
		await run("edit", [
			calls(fauxToolCall("mcp__octocode__localFetch", { queries: [{ path: path.join(cwd, "app.ts") }] })),
			calls(
				nativeCall("file", {
					reason: "Bump the answer",
					queries: [{ reason: "bump", type: "edit", path: "app.ts", edits: [{ oldText: "41", newText: "42" }] }],
				}),
			),
			say("done"),
		]);
		expect(fs.readFileSync(path.join(cwd, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
		// Restoring overwrites files and cannot be undone, so `/rewind` asks first when a UI can answer (`checkpoint-command.ts`).
		ui.confirms.push(false);
		await session.prompt("/rewind");
		expect(ui.notes.at(-1)?.message).toBe("Nothing was rewound.");
		expect(fs.readFileSync(path.join(cwd, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
		ui.confirms.push(true);
		await session.prompt("/rewind");
		expect(fs.readFileSync(path.join(cwd, "app.ts"), "utf8")).toBe("export const answer = 41;\n");
		expect(note(/app\.ts/)).toBeDefined();
	});

	it("asks the user through RPC dialogs", async () => {
		ui.selects.push("2. B — b");
		const question = {
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A (Recommended)", description: "a" },
				{ label: "B", description: "b" },
			],
		};
		const [, second] = await run("ask", [calls(nativeCall("askUser", { questions: [question] })), say("done")]);
		expect(second.results[0].text).toMatch(/Which\?[\s\S]*B/);
	});

	it("coordinates with a peer: locks, refused edits on held paths and messages both ways", async () => {
		const peerHost = fakeHost();
		const peer = new Team(peerHost.api);
		peer.start(fakeCtx({ cwd }));
		peer.join("peer reviewer");
		expect(peer.lock(["held.txt"], "review").ok).toBe(true);
		const replies = [
			calls(agentCall("coordinate", { action: "join", joinGoal: "main" })),
			calls(agentCall("coordinate", { action: "lock", paths: ["held.txt", "mine.txt"] })),
			calls(
				nativeCall("file", {
					reason: "Try the held file",
					queries: [{ reason: "try", type: "write", path: "held.txt", content: "x" }],
				}),
			),
			calls(agentCall("coordinate", { action: "list" })),
			calls(agentCall("message", { to: peer.id!, message: "please release held.txt", replyRequired: false })),
			say("done"),
		];
		const t = await run("team", replies);
		expect(t[1].results[0].text).toMatch(/Joined/i);
		expect(t[2].results[0]).toMatchObject({ isError: true });
		expect(t[2].results[0].text).toContain(peer.id);
		expect(t[3].results[0].text).toMatch(/held\.txt/);
		expect(t[4].results[0].text).toContain(peer.id);
		expect(t[5].results[0].isError).toBe(false);
		await vi.waitFor(() => expect(JSON.stringify(peerHost.sent)).toContain("please release held.txt"), {
			timeout: 5_000,
		});
		const requests = turns.length;
		await session.prompt(`/agents tell ${peer.id} ${"q".repeat(9_000)}`);
		// Over the limit it is delivered, not refused: the head and the path of a file holding all 9,000 characters.
		await vi.waitFor(() => expect(JSON.stringify(peerHost.sent)).toContain("[Full message (9000 characters): "), {
			timeout: 5_000,
		});
		expect(turns).toHaveLength(requests);
		peer.leave();
	});

	it("runs a subagent and an isolated subagent whose changes /agents merge brings in", async () => {
		// Isolation creates a worktree, so the parent asks "Trust new worktree?" once; the user says yes.
		ui.confirms.push(true);
		const t = await run("delegate", [
			calls(
				agentCall("task", { goal: "check things", task: "report facts", profile: "researcher" }),
				agentCall("task", { goal: "check things", task: "edit in a worktree", isolate: true }),
			),
			say("done"),
		]);
		const [plain, isolated] = t.at(-1)!.results;
		expect(plain.text).toMatch(/report \{/);
		// A long report is bounded and kept on disk (the next test pins that); a researcher's role names its skills, so no
		// inherited catalog pads its facts and they may fit inline.
		const full = /Full report: (.+) \(read only the parts you need\)/.exec(plain.text)?.[1];
		expect(full ? fs.readFileSync(full, "utf8") : plain.text).toMatch(/"subagent":"1"/);
		expect(isolated.text).toMatch(/refs\/octocode\/[\w-]+/);
		expect(fs.existsSync(path.join(cwd, "child.txt"))).toBe(false);
		const id = /refs\/octocode\/([\w-]+)/.exec(isolated.text)![1];
		await session.prompt(`/agents merge ${id}`);
		expect(fs.readFileSync(path.join(cwd, "child.txt"), "utf8")).toBe("from the child\n");
	}, 60_000);

	it("bounds a long child report through the real Octocode tool flow and preserves it on disk", async () => {
		const t = await run("long delegation", [
			calls(agentCall("task", { goal: "check things", task: "long report", profile: "researcher" })),
			say("done"),
		]);
		const result = t.at(-1)!.results[0];
		expect(result.isError).toBe(false);
		expect(Buffer.byteLength(result.text)).toBeLessThan(9 * 1024);
		const file = /Full report: (.+) \(read only the parts you need\)/.exec(result.text)![1];
		expect(fs.readFileSync(file, "utf8")).toMatch(/the end$/);
	}, 60_000);

	it("runs background subagents: answers arrive as messages and /agents kill stops one", async () => {
		const before = turns.length;
		const t = await run("background", [
			calls(
				agentCall("task", { goal: "check things", task: "report later", background: true }),
				agentCall("task", { goal: "check things", task: "slow job", background: true }),
			),
			say("waiting"),
			say("got it"),
			say("ok"),
			say("ok"),
		]);
		const [later, slow] = t[1].results;
		const laterId = /^Started (\S+) .* in the background/.exec(later.text)![1];
		const slowId = /^Started (\S+) .* in the background/.exec(slow.text)![1];
		// The finished child's own report reaches the model in a turn of this test (it wakes the session when it arrives
		// after the run). Earlier tests' reports are in the transcript too: only this child's id proves its report arrived.
		const report = new RegExp(`Background subagent ${laterId} \\([^)]*\\) (reported \\w+|finished) \\(`);
		await vi.waitFor(() => expect(turns.slice(before).some((turn) => report.test(turn.context))).toBe(true), {
			timeout: 20_000,
		});
		await settled();
		await session.prompt("/agents kill");
		expect(note(/Running: /)).toBeDefined();
		// The reported child is done: the slow one alone still runs.
		expect(/Running: (.+)$/.exec(note(/Running: /)!)![1].split(", ")).toEqual([slowId]);
		ui.confirms.push(true);
		await session.prompt(`/agents kill ${slowId}`);
		expect(note(new RegExp(`^Stopping ${slowId}`))).toBeDefined();
		// A stop the user asked for wakes no turn: its report is delivered as a session message.
		const cancelled = new RegExp(`Background subagent ${slowId} \\([^)]*\\) cancelled by the user`);
		const delivered = () =>
			session.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom_message" && entry.customType === "octocode-agent-result"
						? [JSON.stringify(entry.content)]
						: [],
				);
		await vi.waitFor(() => expect(delivered().some((content) => cancelled.test(content))).toBe(true), {
			timeout: 20_000,
		});
	}, 60_000);

	it("tracks backlog items and memories with the tools, refuses secrets, and recalls memories in later prompts", async () => {
		const t = await run("track work", [
			calls(
				nativeCall("backlog", {
					op: "add",
					title: "Raise the answer to 43",
					goal: "The answer constant is 43; tests pass.",
					why: "app.ts holds it",
					priority: "p1",
				}),
			),
			calls(nativeCall("backlog", { op: "list", states: ["backlog"] })),
			calls(
				nativeCall("backlog", {
					op: "update",
					id: "B1",
					state: "ongoing",
					why: "Keep the answer correct",
					goal: "The answer constant is 43; tests pass.",
				}),
			),
			calls(nativeCall("backlog", { op: "update", id: "B1", state: "done" })),
			calls(
				nativeCall("backlog", {
					op: "update",
					id: "B1",
					state: "done",
					completion: {
						summary: "Changed app.ts; verified by reading it back.",
						files: [{ path: "app.ts", role: "changed" }],
						verification: { status: "passed", summary: "Read app.ts" },
						operationKey: "feature-e2e-complete",
					},
				}),
			),
			calls(
				nativeCall("archive", {
					source: "memories",
					goal: "remember the answer",
					op: "set",
					title: "The answer constant lives in app.ts",
					body: "Exported as answer from app.ts at the repository root.",
					keywords: "answer constant export",
				}),
			),
			calls(
				nativeCall("archive", {
					source: "memories",
					goal: "remember the answer",
					op: "search",
					keywords: "answer constant",
				}),
			),
			calls(
				nativeCall("archive", {
					source: "memories",
					goal: "remember the answer",
					op: "set",
					title: "Deploy token",
					body: `use ghp_${"a".repeat(36)}`,
				}),
			),
			say("done"),
		]);
		const [added, listed, claimed, noNote, done, saved, found, secret] = t.slice(1).map((turn) => turn.results[0]);
		expect(added.text).toMatch(/^Added B1\b/);
		expect(listed.text).toContain("B1");
		expect(claimed.text).toMatch(/^Updated B1\b/);
		expect(noNote).toMatchObject({ isError: true });
		expect(noNote.text).toMatch(/needs completion/);
		expect(done).toMatchObject({ isError: false });
		expect(saved.text).toMatch(/^Saved M\d+/);
		expect(found.text).toContain("The answer constant lives in app.ts");
		expect(secret).toMatchObject({ isError: true });
		expect(secret.text).toMatch(/GitHub token/);
		// The next prompt that mentions the topic gets the memory injected as data.
		const [next] = await run("where is the answer constant exported?", [say("in app.ts")]);
		expect(next.context).toContain("[octocode-memory");
		expect(next.context).toContain("The answer constant lives in app.ts");
	});

	it("prints /backlog, memory and sessions as text without a UI", async () => {
		const runner = session.extensionRunner;
		runner.setUIContext(undefined, "print");
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		let out: string[];
		try {
			await session.prompt("/backlog add Document the board");
			await session.prompt("/backlog B2 todo");
			await session.prompt("/backlog");
			await session.prompt("/memory add Tabs everywhere — the project indents with tabs");
			await session.prompt("/memory");
			await session.prompt("/memory search answer");
			await session.prompt("/resume");
			out = notify.mock.calls.map((call) => call[0]);
		} finally {
			notify.mockRestore();
			runner.setUIContext(ui, "rpc");
		}
		const board = out.find((text) => /^Todo \(|^Done \(|^Ongoing \(/m.test(text) && text.includes("B1"))!;
		expect(board).toMatch(/Todo \(1\)[\s\S]*B2[\s\S]*Document the board[\s\S]*Done \(1\)[\s\S]*B1/);
		expect(out.some((text) => /^Moved B2\b/.test(text))).toBe(true);
		expect(out.some((text) => /^Saved M\d+ .*Tabs everywhere/.test(text))).toBe(true);
		const listed = out.find((text) => text.startsWith("Memories (auto on)"))!;
		expect(listed).toMatch(/^Workspace:$/m);
		expect(listed).toContain("Tabs everywhere");
		expect(listed).toContain("The answer constant lives in app.ts");
		expect(out.find((text) => text.startsWith('Memories matching "answer"'))).toContain(
			"The answer constant lives in app.ts",
		);
		expect(out.find((text) => text.startsWith("Sessions ("))).toContain(session.sessionManager.getSessionId());
	});

	it("restarts cleanly on reload (shutdown, then a fresh session_start)", async () => {
		await session.reload();
		const [turn] = await run("after reload", [say("ok")]);
		expect(turn.tools).toContain("agent");
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

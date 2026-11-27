import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getInitialSystemMessage,
	getSystemMessageText,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { CLEARED_RESULTS_TYPE } from "../../src/octocode/files/reads.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { createTestSession } from "../helpers/session.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

let root: string;
let cwd: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-session-notes-"));
	cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", "");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const NOTE = "Never run the migrations against production; use the staging copy";

/** A main or subagent memory extension bound to a real in-memory session; `turn` fires what the host fires before a run. */
function harness(options: { subagent?: boolean; mode?: PermissionMode; session?: SessionManager } = {}) {
	const session = options.session ?? SessionManager.inMemory(cwd);
	const fake = fakeHost();
	// The real host appends synchronously into the session file; the fake would only record it.
	Object.assign(fake.api.session, {
		appendEntry: (type: string, data?: unknown) => session.appendCustomEntry(type, data),
	});
	registerMemory(fake.api, {
		commands: new Subcommands(),
		isSubagent: options.subagent === true,
		permission: fakePermission(options.mode ?? "workspace", { api: fake.api }),
	});
	const ctx = (selects: string[] = []) =>
		Object.assign(fakeCtx({ cwd, hasUI: true, ui: { selects, inputs: [] } }), {
			isProjectTrusted: () => true,
			sessionManager: session,
		});
	let calls = 0;
	/** Runs the memory tool and records its result in the session, as a turn does. */
	const tool = async (params: Record<string, unknown>, selects: string[] = []) => {
		const toolCallId = `call-${++calls}`;
		const result = await fake.tools.get("memory").execute(toolCallId, params, undefined, undefined, ctx(selects));
		const id = session.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "memory",
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: Date.now(),
		} as never);
		return { text: result.content[0].text as string, id, toolCallId };
	};
	/** Fires before_agent_start and commits the hidden message it returns, as the host does; undefined when it adds none. */
	const turn = async (messageType: "user" | "custom" = "user", prompt = "carry on") => {
		const result = (await fake.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt, messageType },
			ctx(),
		)) as { message: { customType: string; content: string; details: unknown } } | undefined;
		if (!result) return undefined;
		const { message } = result;
		const id = session.appendCustomMessageEntry(message.customType, message.content, false, message.details);
		return { ...message, id };
	};
	const chat = (text: string) => session.appendMessage({ role: "user", content: text, timestamp: Date.now() } as never);
	return { session, tool, turn, chat, fake, ctx };
}

describe("session notes", () => {
	it("re-injects a saved note verbatim after a compaction summarized its result away", async () => {
		const h = harness();
		const saved = await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE, kind: "decision" });
		expect(saved.text).toMatch(/^Saved S1 \(session, decision\) Staging only/);
		const kept = h.chat("later question");
		h.session.appendCompaction("Earlier work", kept, 100);
		// A run a custom message started (the resume after a compaction) gets it at once: no recall query is involved.
		const injected = await h.turn("custom");
		expect(injected?.customType).toBe("octocode-memory");
		expect(injected?.content).toContain(
			`S1 (session, decision) (agent-written) "Staging only" — ${JSON.stringify(NOTE)}`,
		);
		expect(injected?.details).toMatchObject({ sessionNotes: [{ id: 1, version: 1 }] });
	});

	it("adds nothing while the note is in context", async () => {
		const h = harness();
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE });
		expect(await h.turn()).toBeUndefined();
		h.chat("more work");
		expect(await h.turn("custom")).toBeUndefined();
		// After an injection the note is in context through the injection.
		const compacted = h.chat("kept");
		h.session.appendCompaction("Earlier work", compacted, 100);
		expect(await h.turn()).toBeDefined();
		expect(await h.turn()).toBeUndefined();
	});

	it("re-injects an edited note once, with its new version", async () => {
		const h = harness();
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE });
		const kept = h.chat("kept");
		h.session.appendCompaction("Earlier work", kept, 100);
		await h.turn();
		// The edit's own result is omitted, so only the injected version 1 is in context, and it is stale.
		const edit = await h.tool({ op: "set", id: "S1", body: "Staging only, and ask before touching it" });
		expect(edit.text).toMatch(/^Updated S1/);
		h.session.appendContextEdit(edit.id, null);
		const again = await h.turn();
		expect(again?.content).toContain("ask before touching it");
		expect(again?.content).not.toContain(NOTE);
		expect(again?.details).toMatchObject({ sessionNotes: [{ id: 1, version: 2 }] });
		expect(await h.turn()).toBeUndefined();
	});

	it.each(["clearing", "context_edit"] as const)(
		"re-injects a note whose saving result left the context (%s)",
		async (how) => {
			const h = harness();
			const saved = await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE });
			expect(await h.turn()).toBeUndefined();
			if (how === "clearing")
				h.session.appendCustomEntry(CLEARED_RESULTS_TYPE, { results: [{ id: saved.toolCallId, saved: "/tmp/x.txt" }] });
			else h.session.appendContextEdit(saved.id, { content: "[Old tool result cleared]" });
			const injected = await h.turn();
			expect(injected?.content).toContain(JSON.stringify(NOTE));
			expect(await h.turn()).toBeUndefined();
		},
	);

	it("keeps notes to their session: another and a child session see none, a fork of the branch keeps it", async () => {
		const h = harness();
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE });
		const other = harness();
		await expect(other.tool({ op: "get", id: "S1" })).rejects.toThrow(/S1/);
		expect(await other.tool({ op: "list", scope: "session" })).toMatchObject({
			text: expect.stringContaining("0 matches"),
		});
		const child = harness({ subagent: true });
		await expect(child.tool({ op: "get", id: "S1" })).rejects.toThrow(/S1/);
		expect(await child.turn("custom")).toBeUndefined();
		// A fork carries the branch's entries, so it carries its notes; a note saved there takes the next id.
		const copy = SessionManager.inMemory(cwd, undefined, [h.session.getHeader()!, ...h.session.getEntries()] as never);
		const fork = harness({ session: copy });
		expect((await fork.tool({ op: "get", id: "S1" })).text).toContain(NOTE);
		expect((await fork.tool({ op: "set", scope: "session", title: "Second" })).text).toMatch(/^Saved S2/);
	});

	it("promotes a note through the write path and removes it", async () => {
		const h = harness();
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE, kind: "decision" });
		const selects = ["Allow once"];
		const promoted = await h.tool({ op: "set", id: "S1", scope: "global" }, selects);
		expect(promoted.text).toMatch(/M\d+/);
		expect(promoted.text).toContain("S1");
		// The wide-approval question was asked, and the note is gone from the session.
		expect(selects).toEqual([]);
		await expect(h.tool({ op: "get", id: "S1" })).rejects.toThrow(/S1/);
		expect((await h.tool({ op: "list", scope: "global" })).text).toContain("Staging only");
		// A refusal of the write path keeps the note.
		await h.tool({ op: "set", scope: "session", title: "Second rule" });
		await expect(h.tool({ op: "set", id: "S2", scope: "global" }, ["Deny"])).rejects.toThrow(/user denied/);
		expect((await h.tool({ op: "get", id: "S2" })).text).toContain("Second rule");
		// Deleting needs no approval.
		expect((await h.tool({ op: "delete", id: "S2" })).text).toMatch(/^Deleted S2/);
	});

	it("refuses a secret, and a subagent's set", async () => {
		const h = harness();
		await expect(
			h.tool({ op: "set", scope: "session", title: "Key", body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
		).rejects.toThrow(/secret/);
		expect((await h.tool({ op: "list", scope: "session" })).text).toContain("0 matches");
		const child = harness({ subagent: true });
		await expect(child.tool({ op: "set", scope: "session", title: "Child note" })).rejects.toThrow(/read-only/);
	});

	it("lists session notes first with scope all, and only them with scope session", async () => {
		const h = harness();
		await h.tool({ op: "set", title: "Durable rule" });
		await h.tool({ op: "set", scope: "session", title: "Staging only", body: NOTE });
		const all = (await h.tool({ op: "list" })).text;
		expect(all.indexOf("S1")).toBeGreaterThanOrEqual(0);
		expect(all.indexOf("S1")).toBeLessThan(all.indexOf("Durable rule"));
		const only = (await h.tool({ op: "list", scope: "session" })).text;
		expect(only).toContain("Staging only");
		expect(only).not.toContain("Durable rule");
	});
});

describe("session notes and the cached prefix", () => {
	it("sends identical system prompt and tool definitions before and after saving and re-injecting a note", async () => {
		const dir = tmp("session-notes-cache-");
		const agentDir = path.join(dir, "agent");
		const project = path.join(dir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		for (const [key, value] of Object.entries({
			HOME: path.join(dir, "home"),
			OCTOCODE_HOME: path.join(dir, "home", ".octocode"),
			OCTOCODE_CODING_AGENT_DIR: agentDir,
			OCTOCODE_AGENT_DB: path.join(dir, "agent.sqlite"),
			OCTOCODE_MCP: "0",
			OCTOCODE_OFFLINE: "1",
			OCTOCODE_MODELS_DEV: "0",
			OCTOCODE_PERMISSION: "full",
			OCTOCODE_SUBAGENT: "0",
			OCTOCODE_EXTRA_SKILLS: "0",
		}))
			vi.stubEnv(key, value);
		const captured: Array<{ messages: unknown[]; system: string; tools: string }> = [];
		const faux = createFauxCore({
			provider: "faux-notes",
			models: [{ id: "cache", contextWindow: 200000, maxTokens: 4096 }],
		});
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("memory", { op: "set", scope: "session", title: "Staging only", body: NOTE, kind: "decision" }),
			]),
			fauxAssistantMessage("SAVED"),
			fauxAssistantMessage("## Goal\nSummary of the earlier turns."),
			fauxAssistantMessage("AFTER"),
		]);
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const policy = settingsManager.getCompactionSettings();
		settingsManager.getCompactionSettings = () => ({ ...policy, keepRecentTokens: 1 });
		const resourceLoader = new DefaultResourceLoader({
			cwd: project,
			agentDir,
			settingsManager,
			nativeFeatures: nativeFeatureSet(),
			noPromptTemplates: true,
			noThemes: true,
			features: testFeatures([
				{
					name: "notes-fixture",
					factory: (api) =>
						api.providers.register("faux-notes", {
							name: "Fixture",
							api: faux.api,
							baseUrl: "http://127.0.0.1:0",
							apiKey: "test",
							models: faux.models,
							streamSimple: (
								model: Parameters<typeof faux.streamSimple>[0],
								context: Parameters<typeof faux.streamSimple>[1],
								options?: SimpleStreamOptions,
							) => {
								const copy = structuredClone(context);
								const initial = getInitialSystemMessage(copy.messages);
								captured.push({
									messages: copy.messages,
									system: initial
										? JSON.stringify({ ...initial, toolsAdded: undefined, timestamp: undefined }) +
											getSystemMessageText(initial)
										: "",
									tools: JSON.stringify(initial?.toolsAdded ?? []),
								});
								return faux.streamSimple(model, context, options);
							},
						} as never),
				},
			]),
		});
		await resourceLoader.reload();
		const { session } = await createTestSession({
			cwd: project,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.create(project, path.join(dir, "sessions")),
		});
		await session.bindFeatures({
			mode: "json",
			uiContext: { confirm: async () => true, notify: () => undefined } as never,
			shutdownHandler: () => undefined,
		} as never);
		await session.setModel(session.modelRuntime.getModel("faux-notes", "cache")!);
		try {
			await session.prompt("Remember the staging rule.");
			await session.compact();
			await session.prompt("What was the rule?");
		} finally {
			await session.abort("shutdown");
			await session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		const turns = captured.filter((request) => request.system !== "");
		expect(turns).toHaveLength(4);
		expect(turns[0]?.tools).toContain('"memory"');
		for (const turn of turns) {
			expect(turn.tools).toBe(turns[0].tools);
			expect(turn.system).toBe(turns[0].system);
			expect(turn.system).not.toContain(NOTE);
		}
		// The note came back as a hidden message at the tail, not through the prefix.
		expect(JSON.stringify(turns[3]?.messages)).toContain(NOTE);
	}, 60_000);
});

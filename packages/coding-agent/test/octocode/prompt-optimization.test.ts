import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import octocode from "../../src/octocode/index.ts";
import { createTestSession } from "../helpers/session.ts";
import { resetOctocodeEnv, tmp, trustFolder } from "./helpers.ts";

/**
 * `/optimize` and the prompt hook through a real session, the native extension and a scripted main model. The helper
 * model call (`completeSimple`) is the one external boundary replaced; the dialogs are answered from a queue the way a
 * user would answer them.
 */
const helper = vi.hoisted(() => vi.fn());
vi.mock("@octocodeai/octocode-ai/compat", async (importActual) => ({
	...(await importActual<Record<string, unknown>>()),
	completeSimple: helper,
}));

const savedEnv = { ...process.env };
const root = fs.realpathSync(tmp("octocode-optimize-"));
const cwd = path.join(root, "project");
const agentDir = path.join(root, "agent");

type Session = Awaited<ReturnType<typeof createTestSession>>["session"];
let session: Session;
let faux: ReturnType<typeof createFauxCore>;

/** What the user sees and answers. */
const screen = {
	selects: [] as Array<{ title: string; options: string[] }>,
	answers: [] as Array<string | undefined>,
	editors: [] as Array<{ title: string; prefill?: string }>,
	edits: [] as Array<string | undefined>,
	notes: [] as string[],
	statuses: [] as Array<string | undefined>,
	editorText: [] as string[],
};
const keys = new Set<(data: string) => unknown>();
const ui = new Proxy(
	{
		select: async (title: string, options: string[]) => {
			screen.selects.push({ title, options });
			return screen.answers.shift();
		},
		editor: async (title: string, prefill?: string) => {
			screen.editors.push({ title, prefill });
			return screen.edits.shift();
		},
		notify: (message: string) => screen.notes.push(message),
		setStatus: (key: string, text: string | undefined) => key === "optimize" && screen.statuses.push(text),
		onTerminalInput: (handler: (data: string) => unknown) => {
			keys.add(handler);
			return () => keys.delete(handler);
		},
		setEditorText: (text: string) => screen.editorText.push(text),
	},
	{ get: (target: Record<string, unknown>, key: string) => target[key] ?? (() => undefined) },
);

/** Texts of the user messages the main model was sent, per request. */
const sent: string[] = [];
const lastUserText = (context: TranscriptContext): string => {
	const message = [...context.messages].reverse().find((each) => each.role === "user") as
		| { content: string | Array<{ type: string; text?: string }> }
		| undefined;
	if (!message) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map((part) => part.text ?? "").join("");
};

async function prompt(text: string, options?: { source?: "interactive" | "rpc" | "extension" }): Promise<void> {
	faux.setResponses([
		(context: TranscriptContext) => {
			sent.push(lastUserText(context));
			return fauxAssistantMessage("done");
		},
	]);
	await session.prompt(text, options);
	await vi.waitFor(() => expect(session.isStreaming).toBe(false));
}

const helperReplies = (text: string) => helper.mockResolvedValueOnce(fauxAssistantMessage(text));
const saved = (): { optimizePrompts?: boolean } => {
	const file = path.join(agentDir, "settings.json");
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
};

beforeAll(async () => {
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), "{}");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");
	resetOctocodeEnv();
	Object.assign(process.env, {
		HOME: path.join(root, "home"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		OCTOCODE_HOME: path.join(root, "home", ".octocode"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
		OCTOCODE_MCP: "0",
	});
	trustFolder(cwd);
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
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{ name: "faux-provider", factory: provider },
			{ name: "octocode", factory: octocode },
		],
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	({ session } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	}));
	await session.bindExtensions({ uiContext: ui, mode: "tui", shutdownHandler: () => undefined } as never);
	await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
}, 60_000);

afterAll(async () => {
	await session?.dispose?.();
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

beforeEach(() => {
	helper.mockReset();
	sent.length = 0;
	for (const key of Object.keys(screen) as Array<keyof typeof screen>) screen[key].length = 0;
});

describe("/optimize command", () => {
	it("is a registered command with a short description, a hint and completions", async () => {
		const command = session.extensionRunner.getRegisteredCommands().find((each) => each.name === "optimize");
		expect(command?.argumentHint).toBe("[on|off]");
		expect(command?.description?.length).toBeLessThanOrEqual(50);
		expect((await command?.getArgumentCompletions?.("o"))?.map((item) => item.value)).toEqual(["on", "off"]);
		expect((await command?.getArgumentCompletions?.("of"))?.map((item) => item.value)).toEqual(["off"]);
	});

	it("starts off, shows its state and offers to toggle, and saves the choice", async () => {
		expect(saved().optimizePrompts).toBeUndefined();
		screen.answers.push("Turn on");
		await prompt("/optimize");
		expect(screen.selects[0]?.title).toContain("Prompt optimization is off");
		expect(screen.selects[0]?.options).toEqual(["Turn on", "Keep it"]);
		expect(screen.notes.at(-1)).toContain("Prompt optimization is on");
		expect(saved().optimizePrompts).toBe(true);
		expect(sent).toEqual([]);

		screen.answers.push("Keep it");
		await prompt("/optimize");
		expect(screen.selects[1]?.title).toContain("Prompt optimization is on");
		expect(screen.selects[1]?.options).toEqual(["Turn off", "Keep it"]);
		expect(saved().optimizePrompts).toBe(true);
	});

	it("turns off and on with an argument, saves each, and refuses other words", async () => {
		await prompt("/optimize off");
		expect(saved().optimizePrompts).toBe(false);
		expect(screen.notes.at(-1)).toBe("Prompt optimization is off.");
		await prompt("/optimize ON");
		expect(saved().optimizePrompts).toBe(true);
		await prompt("/optimize sideways");
		expect(screen.notes.at(-1)).toBe("Usage: /optimize [on|off]");
		expect(saved().optimizePrompts).toBe(true);
		expect(screen.selects).toEqual([]);
		expect(helper).not.toHaveBeenCalled();
	});
});

describe("prompt optimization on submit", () => {
	it("sends the prompt unchanged while it is off", async () => {
		await prompt("/optimize off");
		await prompt("fix teh login bug");
		expect(helper).not.toHaveBeenCalled();
		expect(screen.selects).toEqual([]);
		expect(sent).toEqual(["fix teh login bug"]);
	});

	it("asks the helper for a rewrite, shows it, and sends the rewrite when chosen", async () => {
		await prompt("/optimize on");
		helperReplies("Fix the login bug.");
		screen.answers.push("Send the optimized prompt");
		await prompt("fix teh login bug");
		expect(helper).toHaveBeenCalledTimes(1);
		const [model, context, options] = helper.mock.calls[0];
		expect(model.id).toBe("faux-1");
		const asked = JSON.stringify(context.messages);
		expect(asked).toContain("<request>\\nfix teh login bug\\n</request>");
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(screen.selects).toHaveLength(1);
		expect(screen.selects[0]?.title).toContain("Fix the login bug.");
		expect(screen.selects[0]?.options).toEqual([
			"Send the optimized prompt",
			"Edit the optimized prompt",
			"Send my original prompt",
		]);
		expect(screen.statuses).toEqual([expect.stringContaining("✦ Optimizing prompt…"), undefined]);
		expect(sent).toEqual(["Fix the login bug."]);
	});

	it("opens the rewrite in the editor and sends the edited text", async () => {
		helperReplies("Fix the login bug.");
		screen.answers.push("Edit the optimized prompt");
		screen.edits.push("Fix the login bug in auth.ts.");
		await prompt("fix teh login bug");
		expect(screen.editors).toEqual([{ title: "Edit the optimized prompt", prefill: "Fix the login bug." }]);
		expect(sent).toEqual(["Fix the login bug in auth.ts."]);
	});

	it("returns to the choice when the editor is dismissed", async () => {
		helperReplies("Fix the login bug.");
		screen.answers.push("Edit the optimized prompt", "Send my original prompt");
		screen.edits.push(undefined);
		await prompt("fix teh login bug");
		expect(screen.selects).toHaveLength(2);
		expect(sent).toEqual(["fix teh login bug"]);
	});

	it("sends the original when asked", async () => {
		helperReplies("Fix the login bug.");
		screen.answers.push("Send my original prompt");
		await prompt("fix teh login bug");
		expect(sent).toEqual(["fix teh login bug"]);
	});

	it("sends nothing and returns the prompt to the editor when the choice is dismissed", async () => {
		helperReplies("Fix the login bug.");
		screen.answers.push(undefined);
		await prompt("fix teh login bug");
		expect(sent).toEqual([]);
		expect(screen.editorText).toEqual(["fix teh login bug"]);
		expect(screen.notes.at(-1)).toContain("not sent");
	});

	it("sends a prompt the helper leaves as written without a dialog", async () => {
		helperReplies("fix the login bug");
		await prompt("fix the login bug");
		expect(screen.selects).toEqual([]);
		expect(sent).toEqual(["fix the login bug"]);
	});

	it("never rewrites slash commands, ! lines, other sources or empty input", async () => {
		await prompt("/optimize");
		await prompt("!ls -la");
		await prompt("fix the login bug", { source: "rpc" });
		await prompt("fix the login bug", { source: "extension" });
		await prompt("   ");
		expect(helper).not.toHaveBeenCalled();
		expect(screen.selects.map((each) => each.title)).toEqual([expect.stringContaining("Prompt optimization is on")]);
		expect(sent).toEqual(["!ls -la", "fix the login bug", "fix the login bug", "   "]);
	});

	describe("when the helper fails", () => {
		it("says why and sends the original when chosen", async () => {
			helper.mockRejectedValueOnce(new Error("provider is down"));
			screen.answers.push("Send my original prompt");
			await prompt("fix teh login bug");
			expect(screen.selects[0]?.title).toBe("Prompt optimization failed: provider is down. Send your original prompt?");
			expect(screen.selects[0]?.options).toEqual(["Send my original prompt", "Cancel"]);
			expect(sent).toEqual(["fix teh login bug"]);
			expect(screen.statuses.at(-1)).toBeUndefined();
		});

		it("keeps the prompt in the editor when the user cancels", async () => {
			helper.mockResolvedValueOnce(fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }));
			screen.answers.push("Cancel");
			await prompt("fix teh login bug");
			expect(screen.selects[0]?.title).toContain("rate limited");
			expect(sent).toEqual([]);
			expect(screen.editorText).toEqual(["fix teh login bug"]);
		});

		it("lets Esc skip a slow helper and offers the original", async () => {
			helper.mockImplementationOnce(
				(_model, _context, options: { signal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						options.signal.addEventListener("abort", () => reject(new Error("aborted")));
						setTimeout(() => keys.forEach((handler) => handler("\x1b")), 20);
					}),
			);
			screen.answers.push("Send my original prompt");
			await prompt("fix teh login bug");
			expect(screen.selects[0]?.title).toBe("Prompt optimization failed: it was skipped. Send your original prompt?");
			expect(keys.size).toBe(0);
			expect(sent).toEqual(["fix teh login bug"]);
		});

		it("treats an empty reply as a failure", async () => {
			helperReplies("   ");
			screen.answers.push("Send my original prompt");
			await prompt("fix teh login bug");
			expect(screen.selects[0]?.title).toContain("returned an empty reply");
			expect(sent).toEqual(["fix teh login bug"]);
		});
	});

	it("stops rewriting after /optimize off", async () => {
		await prompt("/optimize off");
		await prompt("fix teh login bug");
		expect(helper).not.toHaveBeenCalled();
		expect(sent).toEqual(["fix teh login bug"]);
		expect(saved().optimizePrompts).toBe(false);
	});
});

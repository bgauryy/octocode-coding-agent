import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createFauxCore,
	fauxAssistantMessage,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { resetOctocodeEnv, tmp, trustFolder } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * A headless Octocode session (no UI, as print and JSON mode run) in a fresh git repository, driven by a scripted model.
 * Only the model provider is faked; the extension, permission gate, tools and filesystem (inside a temp root) are real.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY =
	process.env.OCTOCODE_E2E_ENTRY === "dist"
		? path.join(HERE, "..", "..", "dist", "index.js")
		: path.join(HERE, "..", "..", "src", "index.ts");
const octocode = (await import(ENTRY)).default as FeatureRegister;

export type ToolResult = { toolName: string; isError: boolean; text: string };
type Reply = (context: TranscriptContext, options?: SimpleStreamOptions) => ReturnType<typeof fauxAssistantMessage>;

/** The tool results the model was sent in the turn after a call. */
function toolResults(context: TranscriptContext): ToolResult[] {
	const found: ToolResult[] = [];
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
		found.unshift({ toolName: String(message.toolName), isError: message.isError === true, text });
	}
	return found;
}

export const say = (text: string) => () => fauxAssistantMessage(text);

const sessions: Array<{ dispose(): void }> = [];
const savedEnv = { ...process.env };

/** Disposes every session started since the last call. */
export function disposeSessions(): void {
	for (const session of sessions.splice(0)) session.dispose();
}

/** Puts back the environment the test file started with. */
export function restoreEnv(): void {
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, savedEnv);
}

export interface HeadlessOptions {
	/** Extra `OCTOCODE_*` (or other) variables for the session. */
	env?: Record<string, string>;
	/** Runs in the repository before the session starts (files, symlinks, commits). */
	setup?: (paths: { root: string; cwd: string; home: string; outside: string }) => void;
	/** Loads AGENTS.md files and the skills under these folders (each a folder of `<name>/SKILL.md`), which a headless run skips by default. */
	resources?: { contextFiles?: boolean; skillPaths?: string[] };
}

export async function headless(options: HeadlessOptions = {}) {
	const root = fs.realpathSync(tmp("octocode-e2e-behavior-"));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const outside = path.join(root, "outside");
	for (const dir of [cwd, home, outside]) fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), "{}");
	fs.writeFileSync(path.join(cwd, "app.ts"), "export const answer = 41;\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");
	options.setup?.({ root, cwd, home, outside });

	// The extension reads the environment when the session starts: change the same object, never replace it.
	resetOctocodeEnv();
	Object.assign(
		process.env,
		{
			HOME: home,
			OCTOCODE_CODING_AGENT_DIR: path.join(root, "agent"),
			OCTOCODE_HOME: path.join(home, ".octocode"),
			OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
			OCTOCODE_MCP: "0",
			OCTOCODE_OFFLINE: "1",
		},
		options.env ?? {},
	);
	fs.mkdirSync(path.join(root, "agent"), { recursive: true });
	trustFolder(cwd);

	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }] as never,
	});
	const provider: FeatureRegister = (api) => {
		api.providers.register("faux", {
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
		agentDir: path.join(root, "agent"),
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([
			{ name: "faux-provider", factory: provider },
			{ name: "octocode", factory: octocode },
		]),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: !options.resources?.contextFiles,
		...(options.resources?.skillPaths ? { additionalSkillPaths: options.resources.skillPaths } : {}),
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir: path.join(root, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	sessions.push(session);
	await session.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
	await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);

	const turns: ToolResult[][] = [];
	/** The transcript each request carried, oldest request first (for comparing what two requests share). */
	const contexts: TranscriptContext[] = [];
	/** The stream options (session id, cache key and policy, instruction boundaries) each request carried, as `contexts`. */
	const requestOptions: Array<SimpleStreamOptions | undefined> = [];
	/** Prompts once with scripted replies; returns the tool results each reply saw (the first sees none). */
	const run = async (prompt: string, replies: Array<() => ReturnType<typeof fauxAssistantMessage>>) => {
		const start = turns.length;
		faux.setResponses(
			replies.map((reply): Reply => (context, options) => {
				turns.push(toolResults(context));
				contexts.push(context);
				requestOptions.push(options);
				return reply();
			}),
		);
		await session.prompt(prompt);
		return turns.slice(start);
	};
	/** The permission audit entries this session recorded. */
	const audit = () =>
		session.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === "octocode-permission"
					? [entry.data as { action: string; allowed: boolean; via: string; mode: string }]
					: [],
			);
	return { root, cwd, home, outside, run, session, audit, contexts, requestOptions };
}

import fs from "node:fs";
import path from "node:path";
import { createFauxCore, type TranscriptContext } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A tool that runs until the test calls `release`; `entered` resolves when the model's call started it. */
export function gate() {
	let release!: () => void;
	let entered!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	const started = new Promise<void>((resolve) => (entered = resolve));
	return { release, entered, released, started };
}

export interface LiveTool {
	name: string;
	run: (signal: AbortSignal | undefined, ctx: ExtensionContext) => Promise<string>;
}

export interface LiveOptions {
	tools: LiveTool[];
	/** The environment of the session's Team: a subagent has `OCTOCODE_AGENT_ID` and `OCTOCODE_PARENT_ID`. */
	env?: Record<string, string>;
	/** Share this team database (a second agent in the same test); default: a fresh one. */
	db?: string;
	cwd?: string;
	mode?: "tui" | "print";
	/** Registers more real tools (for example `bash`) in the session; `names` are enabled with the test tools. */
	extra?: { register: (api: ExtensionAPI) => void; names: string[] };
	/** The peer's agent id (set it as `OCTOCODE_PARENT_ID` of a session that plays a subagent). */
	peerId?: string;
	/** The peer's environment once this session has joined (its id is `selfId`): make the peer a subagent of it. */
	peerEnv?: (selfId: string) => Record<string, string>;
}

/**
 * A real Octocode session (queues, steering, boundaries, transcript) with a scripted model and a real `Team`, plus a
 * peer on the same team database. `requests` lists, for every model call, the team mail text the model could read and when.
 */
export async function liveSession(options: LiveOptions) {
	const cwd = options.cwd ?? tmp();
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const db = options.db ?? path.join(tmp(), "team.sqlite");
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
	});
	let team!: Team;
	let api!: ExtensionAPI;
	const factory: ExtensionFactory = (host) => {
		api = host;
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models,
			streamSimple: faux.streamSimple,
		} as never);
		team = new Team(api, { OCTOCODE_AGENT_DB: db, ...options.env });
		registerCollab(api, team);
		options.extra?.register(api);
		for (const tool of options.tools)
			api.registerTool({
				name: tool.name,
				label: tool.name,
				description: `Test tool ${tool.name}`,
				parameters: Type.Object({}),
				async execute(_id, _args, signal, _onUpdate, ctx) {
					return { content: [{ type: "text", text: await tool.run(signal, ctx) }], details: undefined };
				},
			});
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "live-session", factory }],
		disabledFeatures: ["mcp", "llama.cpp"],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager,
		tools: [...options.tools.map((tool) => tool.name), ...(options.extra?.names ?? [])],
	});
	const ui = fakeCtx({ cwd }).ui;
	const mode = options.mode ?? "tui";
	await session.bindExtensions({
		mode,
		...(mode === "tui" ? { uiContext: ui } : {}),
		shutdownHandler: () => undefined,
	});
	await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
	const joined = team.id ?? team.join().id;

	// A second agent on the same database.
	const peerHost = fakeHost();
	const peer = new Team(peerHost.api, {
		OCTOCODE_AGENT_DB: db,
		...(options.peerId ? { OCTOCODE_AGENT_ID: options.peerId } : {}),
		...options.peerEnv?.(joined),
	});
	registerCollab(peerHost.api, peer);
	peer.start(fakeCtx({ cwd }));
	peer.join();

	const requests: Array<{ at: number; mail: string[] }> = [];
	/** What a scripted reply records: the team mail text in the conversation the model is called with. */
	const record = (context: TranscriptContext) => {
		const mail = context.messages.flatMap((message) => {
			const text = JSON.stringify(message.content);
			return text.includes("MAIL:") ? [text.slice(text.indexOf("MAIL:"), text.indexOf("MAIL:") + 40)] : [];
		});
		requests.push({ at: Date.now(), mail });
	};
	let closing: Promise<void> | undefined;
	return {
		session,
		sessionManager,
		team,
		peer,
		api,
		faux,
		id: joined,
		requests,
		record,
		db,
		cwd,
		close() {
			return (closing ??= (async () => {
				peer.stop();
				try {
					await session.abort("shutdown");
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} finally {
					team.stop();
					session.dispose();
				}
			})());
		},
	};
}

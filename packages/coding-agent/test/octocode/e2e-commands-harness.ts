import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import type { Terminal } from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../src/core/application/index.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/features/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
// As `interactive-mode.ts` does before building the host: MCP's terminal UI port.
import "../../src/modes/interactive/mcp-ui-install.ts";
import { createInteractiveModeHost } from "../../src/modes/interactive/interactive-mode/create-host.ts";
import type { InteractiveModeHost } from "../../src/modes/interactive/interactive-mode/host.ts";
import { tmp } from "./helpers.ts";

/**
 * The real interactive mode (editor, command dispatch, extension UI) over a terminal that draws nothing, with a real
 * runtime, the native extension and the Octocode MCP server. Only the model provider is scripted; the terminal is the
 * input boundary, so a dialog is answered the way a user would, by pressing Escape.
 */
class NullTerminal implements Terminal {
	private onInput?: (data: string) => void;
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {
		this.onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return 120;
	}
	get rows(): number {
		return 40;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	press(data: string): void {
		this.onInput?.(data);
	}
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/g;

/** What a submitted line did: the transcript text it added, the dialogs it opened and whether it finished. */
export interface Outcome {
	text: string;
	dialogs: string[];
	settled: boolean;
	error?: string;
}

export interface InteractiveHarness {
	host: InteractiveModeHost;
	root: string;
	cwd: string;
	/** The model requests made so far, newest last, as the text the model was sent. */
	requests: string[];
	reply(...texts: string[]): void;
	submit(text: string, timeoutMs?: number): Promise<Outcome>;
	stop(): Promise<void>;
}

const savedEnv = { ...process.env };

export async function startInteractive(): Promise<InteractiveHarness> {
	const root = fs.realpathSync(tmp("octocode-e2e-commands-"));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(cwd, "app.ts"), "export const answer = 41;\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");

	// The extension reads the environment when the session starts: change the same object, never replace it.
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		HOME: home,
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
		OCTOCODE_MCP: "1",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_PERMISSION: "workspace",
	});

	const faux = createFauxCore({
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
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [{ name: "faux-provider", factory: provider }],
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const model = services.modelRuntime.getModel("faux", "faux-1");
		return {
			...(await createSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
	});
	const terminal = new NullTerminal();
	const host = createInteractiveModeHost(runtime, { terminal });
	await host.init();
	// The input loop of `startup.run`, without its startup network checks: a submitted line that is not a terminal
	// command (extension, skill and prompt commands, plain text) reaches the session here.
	let busy = false;
	let stopped = false;
	void (async () => {
		while (!stopped) {
			const input = await host.getUserInput();
			if (stopped) return;
			busy = true;
			try {
				await getApplicationPort(host.session).invoke("prompt", input);
			} catch (error: unknown) {
				host.showError(error instanceof Error ? error.message : String(error));
			} finally {
				busy = false;
			}
		}
	})();

	const requests: string[] = [];
	const reply = (...texts: string[]) =>
		faux.setResponses(
			texts.map((text) => (context: TranscriptContext) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(text);
			}),
		);
	const screen = () =>
		[host.chatContainer, host.statusContainer, host.editorContainer]
			.flatMap((container) => container.render(120))
			.join("\n")
			.replace(ANSI, "");
	const transcript = () => host.chatContainer.render(120).map((line) => line.replace(ANSI, ""));
	/** The transcript from the first line that changed since `before` (a status line may be redrawn in place). */
	const added = (before: string[]) => {
		const after = transcript();
		let same = 0;
		while (same < before.length && same < after.length && before[same] === after[same]) same++;
		return after.slice(same).join("\n");
	};
	const editorOnly = () => host.editorContainer.render(120).join("\n");

	const submit = async (text: string, timeoutMs = 15_000): Promise<Outcome> => {
		const before = transcript();
		const idleEditor = editorOnly();
		const dialogs: string[] = [];
		let settled = false;
		let error: string | undefined;
		const done = Promise.resolve(host.defaultEditor.onSubmit?.(text))
			.catch((caught: unknown) => {
				error = caught instanceof Error ? caught.message : String(caught);
			})
			.finally(() => {
				settled = true;
			});
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const open = editorOnly() !== idleEditor && host.editor !== host.defaultEditor;
			if (open || host.activeSelectorDispose) {
				// A selector or dialog replaced the editor: note what it shows, then dismiss it as a user would.
				dialogs.push(screen().split("\n").filter(Boolean).slice(-12).join("\n"));
				terminal.press("\x1b");
				if (dialogs.length > 6) break;
				continue;
			}
			if (settled && !busy && !runtime.session.isStreaming) break;
		}
		if (settled) await done;
		return {
			text: added(before),
			dialogs,
			settled: settled && !busy,
			error,
		};
	};

	const stop = async () => {
		stopped = true;
		host.onInputCallback?.("");
		host.stop();
		await runtime.dispose();
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, savedEnv);
	};
	return { host, root, cwd, requests, reply, submit, stop };
}

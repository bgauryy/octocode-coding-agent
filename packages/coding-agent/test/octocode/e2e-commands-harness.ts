import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import {
	createFauxCore,
	fauxAssistantMessage,
	type FauxResponseStep,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import type { Terminal } from "@octocodeai/octocode-tui";
import {
	type CreateAgentSessionRuntimeFactory,
	createSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
// As `interactive-mode.ts` does before building the host: MCP's terminal UI port.
import "../../src/modes/interactive/mcp-ui-install.ts";
import { createInteractiveModeHost } from "../../src/modes/interactive/interactive-mode/create-host.ts";
import type { InteractiveModeHost } from "../../src/modes/interactive/interactive-mode/host.ts";
import { submitPrompt } from "../../src/modes/interactive/interactive-mode/refused-input.ts";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { recordProcessAlive } from "../../src/octocode/web-daemon/records.ts";
import { daemonRequest, findWebDaemon } from "../../src/octocode/web-daemon/launcher.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

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

/** Lines of a dialog a run notes: a page's title, facts, every row and its hint line on the 40-row terminal. */
const DIALOG_LINES = 24;

/** What a submitted line did: the transcript text it added, the dialogs it opened and whether it finished. */
export interface Outcome {
	text: string;
	dialogs: string[];
	settled: boolean;
	error?: string;
}

/** A terminal a test can type into: `NullTerminal.press`, or `VirtualTerminal.sendInput` plus its screen grid. */
export type InputTerminal = Terminal & {
	press?(data: string): void;
	sendInput?(data: string): void;
	flushAndGetViewport?(): Promise<string[]>;
	getScrollBuffer?(): string[];
};

export interface InteractiveOptions {
	/** Replaces the terminal that draws nothing, e.g. `new VirtualTerminal(120, 40)` from `packages/tui/test`. */
	terminal?: InputTerminal;
	/** Files written into the project (relative path -> content) before the session starts. */
	files?: Record<string, string>;
	/** Model ids the scripted provider offers (default `["faux-1"]`); the first is the session's model. */
	models?: string[];
}

/** One scripted model turn: text, or a function that decides (and may wait) given the request. */
export type Step = string | FauxResponseStep;

export interface InteractiveHarness {
	/** The terminal the host draws to and reads keys from. */
	terminal: InputTerminal;
	/** Types raw input (keys, paste) into the terminal. */
	press(data: string): void;
	/** The terminal's visible rows (needs a `VirtualTerminal`); the render-based `screen()` text otherwise. */
	grid(): Promise<string[]>;
	/** Waits until `predicate` holds, polling; throws with the grid after `timeoutMs`. */
	until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs?: number): Promise<void>;
	/** Scripted turns that may wait, e.g. `script(hang(), "after")`; each request is recorded in `requests`. */
	script(...steps: Step[]): void;
	/** Visible chat, status and editor text (render-based, ANSI stripped). */
	screen(): string;
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

export async function startInteractive(options: InteractiveOptions = {}): Promise<InteractiveHarness> {
	const root = fs.realpathSync(tmp("octocode-e2e-commands-"));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(cwd, "app.ts"), "export const answer = 41;\n");
	for (const [file, content] of Object.entries(options.files ?? {})) {
		fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
		fs.writeFileSync(path.join(cwd, file), content);
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init");

	// The extension reads the environment when the session starts: change the same object, never replace it.
	resetOctocodeEnv();
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
		models: (options.models ?? ["faux-1"]).map((id) => ({ id, contextWindow: 200_000, maxTokens: 4_096 })),
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
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				nativeFeatures: nativeFeatureSet(),
				features: testFeatures([{ name: "faux-provider", factory: provider }]),
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const model = services.modelRuntime.getModel("faux", options.models?.[0] ?? "faux-1");
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
	const terminal: InputTerminal = options.terminal ?? new NullTerminal();
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
				await submitPrompt(host, input);
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
	const press = (data: string) => (terminal.press ?? terminal.sendInput)?.call(terminal, data);
	const script = (...steps: Step[]) =>
		faux.setResponses(
			steps.map((step): FauxResponseStep => {
				const make = typeof step === "string" ? () => fauxAssistantMessage(step) : step;
				return (context, streamOptions, state, model) => {
					requests.push(JSON.stringify(context.messages));
					return typeof make === "function" ? make(context, streamOptions, state, model) : make;
				};
			}),
		);
	const screen = () =>
		[host.chatContainer, host.statusContainer, host.editorContainer]
			.flatMap((container) => container.render(120))
			.join("\n")
			.replace(ANSI, "");
	const grid = async () => (terminal.flushAndGetViewport ? terminal.flushAndGetViewport() : screen().split("\n"));
	const until: InteractiveHarness["until"] = async (predicate, what, timeoutMs = 15_000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`Timed out waiting for ${what}. Screen:\n${(await grid()).join("\n")}`);
	};
	const transcript = () => host.chatContainer.render(120).map((line) => line.replace(ANSI, ""));
	/** The transcript from the first line that changed since `before` (a status line may be redrawn in place). */
	const added = (before: string[]) => {
		const after = transcript();
		let same = 0;
		while (same < before.length && same < after.length && before[same] === after[same]) same++;
		return after.slice(same).join("\n");
	};
	// A selector or dialog takes the editor's place in its container; the editor's own rows change too (the empty-prompt
	// hint returns in a fresh session), so they cannot tell a dialog apart.
	const dialogOpen = () => !host.editorContainer.children.includes(host.editor);

	const submit = async (text: string, timeoutMs = 15_000): Promise<Outcome> => {
		const before = transcript();
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
			await new Promise((resolve) => setTimeout(resolve, 15));
			if (dialogOpen() || host.activeSelectorDispose) {
				// A selector or dialog replaced the editor: note what it shows (title, rows and hint line), then dismiss it as a user would.
				dialogs.push(screen().split("\n").filter(Boolean).slice(-DIALOG_LINES).join("\n"));
				press("\x1b");
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
		// This harness's home has its own agent database: close its connections and writer threads with the run.
		closeSharedAgentDb();
		// `/web` and `/remote` start the detached user-level daemon in this home: ask it to exit with the run.
		const daemon = await findWebDaemon(process.env);
		if (daemon) {
			await daemonRequest(daemon, DAEMON_ROUTES.drain, { method: "POST" });
			await until(async () => !(await recordProcessAlive(daemon.record)), "isolated web daemon to exit");
		}
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, savedEnv);
	};
	return { host, root, cwd, requests, reply, submit, stop, terminal, press, grid, until, script, screen };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, GLYPH } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createSessionFromServices } from "../src/core/agent-session/create-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import * as startup from "../src/modes/interactive/interactive-mode/startup.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createTestResourceLoader } from "./utilities.ts";

const WARNING = "No AI provider connected yet. Type /providers to connect one with an account or API key.";

/** Environment names that could hold an ambient credential a built-in provider would find. */
const AMBIENT_CREDENTIAL = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^AWS_|GOOGLE|GCLOUD|CLOUDSDK|AZURE|VERTEX|BEDROCK/i;

/**
 * A session made the way a CLI start makes one, with nothing connected: no stored, environment or ambient credential
 * (the home is an empty folder), so no model is available and the session is created without one.
 */
async function createSessionWithoutModel(cleanups: Array<() => void>): Promise<AgentSession> {
	const root = mkdtempSync(join(tmpdir(), "octocode-no-model-start-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	vi.stubEnv("HOME", root);
	vi.stubEnv("USERPROFILE", root);
	for (const name of Object.keys(process.env)) if (AMBIENT_CREDENTIAL.test(name)) vi.stubEnv(name, undefined);
	cleanups.push(() => vi.unstubAllEnvs());
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	cleanups.push(() => runtime.dispose());
	const { session } = await createSessionFromServices({
		services: {
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			diagnostics: [],
		},
		sessionManager: SessionManager.inMemory(root),
		noTools: "all",
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** `startup.run` on a fake host: everything before the main loop runs, and the loop waits for input forever. */
function start(session: AgentSession, editor = { handleInput: vi.fn() }) {
	const showSelector = vi.fn();
	const showWarning = vi.fn();
	const context = {
		editor,
		init: vi.fn(async () => {}),
		options: { modelFallbackMessage: WARNING },
		chatContainer: new Container(),
		ui: { requestRender: vi.fn(), terminal: { rows: 60 } },
		version: "test",
		session,
		checkForPackageUpdates: vi.fn().mockResolvedValue([]),
		checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
		getUserInput: vi.fn(() => new Promise<string>(() => {})),
		showSelector,
		showWarning,
	};
	void startup.run(createFakeHost(context));
	return { showSelector, showWarning, getUserInput: context.getUserInput };
}

describe("interactive start", () => {
	let harness: Harness | undefined;
	const cleanups: Array<() => void> = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	it("with no usable model opens /providers on + Provider under one line saying why", async () => {
		// The real creation path: the agent holds its placeholder model, which the session reports as no model.
		const session = await createSessionWithoutModel(cleanups);
		expect(session.model).toBeUndefined();
		const { showSelector, showWarning, getUserInput } = start(session);
		await vi.waitFor(() => expect(showSelector).toHaveBeenCalled());
		const page = showSelector.mock.calls[0][0](vi.fn()).component as { render(width: number): string[] };
		const lines = stripAnsi(page.render(120).join("\n")).split("\n");
		expect(lines[1]?.trim()).toBe("AI providers · no usable model yet — add a provider to start");
		expect(lines.find((line) => line.includes(`${GLYPH.cursor} `))).toContain("+ Provider");
		expect(showWarning).not.toHaveBeenCalledWith(WARNING);
		// The page holds the start: the main loop waits until it closes.
		expect(getUserInput).not.toHaveBeenCalled();
	});

	it("closes that page on a typed / and hands the key to the editor, so a command typed at start is kept", async () => {
		const session = await createSessionWithoutModel(cleanups);
		const editor = { handleInput: vi.fn() };
		const { showSelector, getUserInput } = start(session, editor);
		await vi.waitFor(() => expect(showSelector).toHaveBeenCalled());
		const done = vi.fn();
		const page = showSelector.mock.calls[0][0](done).component as {
			render(width: number): string[];
			handleInput(data: string): void;
		};
		expect(stripAnsi(page.render(120).join("\n"))).toContain("Type / to close this page and run a command.");
		// Other keys stay the page's: the cursor moves, nothing closes.
		page.handleInput("\x1b[B");
		expect(done).not.toHaveBeenCalled();
		page.handleInput("/");
		expect(done).toHaveBeenCalledTimes(1);
		expect(editor.handleInput).toHaveBeenCalledWith("/");
		// The start goes on to the main loop.
		await vi.waitFor(() => expect(getUserInput).toHaveBeenCalled());
	});

	it("with a model keeps the warning and opens no page", async () => {
		harness = await createHarness();
		const { showSelector, showWarning, getUserInput } = start(harness.session);
		await vi.waitFor(() => expect(getUserInput).toHaveBeenCalled());
		expect(showWarning).toHaveBeenCalledWith(WARNING);
		expect(showSelector).not.toHaveBeenCalled();
	});
});

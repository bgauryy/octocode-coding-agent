import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLYPH, Input, setKeybindings } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getBuiltinCommand } from "../src/core/slash-commands.ts";
import { getLoginProviderOptions } from "../src/modes/interactive/interactive-mode/login-flow.ts";
import { removeProviderCredential } from "../src/modes/interactive/interactive-mode/provider-actions.ts";
import { showProviderManager } from "../src/modes/interactive/interactive-mode/provider-manager.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function manager() {
	const codex = {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: { oauth: { name: "ChatGPT account", login: async () => ({}) } },
	};
	const anthropic = {
		id: "anthropic",
		name: "Anthropic",
		auth: { apiKey: { name: "API key", login: async () => ({}) } },
	};
	const provider = {
		id: "openai",
		name: "OpenAI",
		auth: {
			apiKey: { name: "API key", login: async () => ({ type: "api_key", key: "test" }) },
			oauth: { name: "OpenAI account", login: async () => ({}) },
		},
	};
	let disabled: string[] = [];
	let configDir: string | undefined = "/home/test/.octocode";
	const runtime = {
		getConfigurationDirectory: () => configDir,
		setDisabledProviders: vi.fn((ids: string[]) => {
			disabled = ids;
		}),
		getProviders: () => [provider, codex, anthropic],
		getProvider: (id: string) => [provider, codex, anthropic].find((entry) => entry.id === id),
		getModels: () => [{ id: "one" }],
		getAvailableSnapshot: () => [{ provider: "openai", id: "one" }],
		getProviderAuthStatus: (id: string) => ({
			configured: id === "openai",
			source: "environment",
			label: "OPENAI_API_KEY",
		}),
		isUsingOAuth: () => false,
		hasConfiguredAuth: (id: string) => id === "openai",
		listCredentials: vi.fn(async () => [{ providerId: "openai", type: "api_key" }]),
		logout: vi.fn(async () => {}),
	};
	const value = {
		session: {
			modelRuntime: runtime,
			model: { provider: "openai", id: "one" },
			settingsManager: {
				getProviderSources: () => ({}),
				getDisabledProviders: () => disabled,
				setDisabledProviders: vi.fn((ids: string[]) => {
					disabled = ids;
				}),
			},
		},
		showWarning: vi.fn(),
		showSelector: vi.fn(),
		showExtensionSelector: vi.fn(),
		showLoginDialog: vi.fn(),
		showApiKeyLoginDialog: vi.fn(),
		showAmbientAuthDialog: vi.fn(),
		showModelSelector: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
		ui: { requestRender: vi.fn() },
		getLoginProviderOptions: () => getLoginProviderOptions(createFakeHost(value)),
	};
	return {
		host: createFakeHost(value),
		value,
		runtime,
		setConfigDir: (dir: string | undefined) => {
			configDir = dir;
		},
	};
}

type Fixture = ReturnType<typeof manager>;

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

/** The nth page `showSelector` was asked to open, built the way the host builds it. */
async function pageAt(value: Fixture["value"], index: number) {
	await vi.waitFor(() => expect(value.showSelector.mock.calls.length).toBeGreaterThan(index));
	const { component } = value.showSelector.mock.calls[index][0](vi.fn());
	return component as { render(width: number): string[]; handleInput(data: string): void };
}
const textOf = (page: { render(width: number): string[] }, width = 160) => stripAnsi(page.render(width).join("\n"));
const selectedLine = (page: { render(width: number): string[] }) =>
	textOf(page)
		.split("\n")
		.find((line) => line.includes(`${GLYPH.cursor} `)) ?? "";
/** Moves down to the row whose text contains `label` and opens it. */
function choose(page: { render(width: number): string[]; handleInput(data: string): void }, label: string): void {
	for (let step = 0; step < 40; step++) {
		if (selectedLine(page).includes(label)) {
			page.handleInput(ENTER);
			return;
		}
		page.handleInput(DOWN);
	}
	throw new Error(`no row "${label}" in:\n${textOf(page)}`);
}
const rows = (page: { render(width: number): string[] }) =>
	textOf(page)
		.split("\n")
		.filter((line) => line.trim());

let home: string;
const sourceEnvironment = () => ({ home, env: {}, agentDir: join(home, ".octocode", "octocodecode") });

describe("provider setup flow", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		home = mkdtempSync(join(tmpdir(), "providers-home-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("names provider access /providers and keeps each command under one name", () => {
		expect(getBuiltinCommand("providers")?.name).toBe("providers");
		expect(getBuiltinCommand("providers")?.description).toContain("enable or disable");
		// v20.0.1 (25685858) removed /github: GitHub access goes through `/octocode login`.
		for (const removed of ["login", "models", "github"]) expect(getBuiltinCommand(removed)).toBeUndefined();
		expect(getBuiltinCommand("modelsettings")?.description).toContain("routing");
	});

	it("main page: Signed in, Sign in, Sources, Detected and Custom models in order, each provider once", async () => {
		const { host, value } = manager();
		mkdirSync(join(home, ".codex"));
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		const output = textOf(page);
		const at = ["Signed in", "Sign in", "Sources", "Detected", "Custom models"].map((heading) =>
			output.search(new RegExp(`^ ${heading}$`, "m")),
		);
		expect(at.every((position) => position >= 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(output).not.toMatch(/^ Disabled$/m);
		expect(output.match(/OpenAI\b/g)?.length).toBeGreaterThanOrEqual(1);
		expect(output).toMatch(/OpenAI +key · OPENAI_API_KEY · 1 model +enabled/);
		expect(output).toContain("+ Add a provider");
		expect(output).toMatch(/Octocode .*auth\.json.* on/);
		expect(output).toMatch(/Pi .*auth\.json.* on/);
		expect(output).toMatch(/COPILOT_GITHUB_TOKEN .* off/);
		expect(output).toMatch(/Codex CLI +~\/\.codex → sign in with OpenAI Codex/);
		expect(output).toContain("Octocode models.json");
		expect(output).toContain("/home/test/.octocode/models.json");
		expect(output).toContain("not verified");
		expect(value.showLoginDialog).not.toHaveBeenCalled();
		page.handleInput(ESC);
		await run;
	});

	it("main page: a disabled provider moves to its own section and `e` toggles it", async () => {
		const { host, value, runtime } = manager();
		value.session.settingsManager.setDisabledProviders(["openai"]);
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const first = await pageAt(value, 0);
		expect(textOf(first)).toMatch(/^ Disabled$/m);
		expect(textOf(first)).toMatch(/OpenAI .* disabled/);
		first.handleInput("e");
		const second = await pageAt(value, 1);
		expect(runtime.setDisabledProviders).toHaveBeenLastCalledWith([]);
		expect(textOf(second)).not.toMatch(/^ Disabled$/m);
		expect(value.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Enabled OpenAI"));
		second.handleInput(ESC);
		await run;
	});

	it("the Sign in row opens the sign-in picker, then that provider's sign-in", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		choose(page, "+ Add a provider");
		const picker = await pageAt(value, 1);
		expect(textOf(picker)).toContain("Sign in — choose a provider");
		expect(textOf(picker)).toContain("OpenAI Codex");
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		picker.handleInput(ENTER);
		await run;
		expect(value.showLoginDialog).toHaveBeenCalledWith("openai-codex", "OpenAI Codex", expect.any(Function));
	});

	it("opens a detected tool's action: Octocode's own sign-in, or API-key entry; nothing is read from the tool", async () => {
		const { host, value } = manager();
		mkdirSync(join(home, ".codex"));
		mkdirSync(join(home, ".claude"));
		writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":"SECRET-NEVER-SHOWN"}');
		const codexRun = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const codexPage = await pageAt(value, 0);
		expect(textOf(codexPage)).not.toContain("SECRET-NEVER-SHOWN");
		choose(codexPage, "Codex CLI");
		await codexRun;
		expect(value.showLoginDialog).toHaveBeenCalledWith("openai-codex", "OpenAI Codex", expect.any(Function));

		const claudeRun = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const claudePage = await pageAt(value, 1);
		choose(claudePage, "Claude Code");
		await claudeRun;
		expect(value.showApiKeyLoginDialog).toHaveBeenCalledWith("anthropic", "Anthropic", expect.any(Function));
	});

	it("a source's page toggles Pi through settings and reapplies the sources; Octocode has no toggle", async () => {
		const { host, value } = manager();
		const settings = value.session.settingsManager as Record<string, unknown>;
		const setProviderSourceEnabled = vi.fn();
		settings.setProviderSourceEnabled = setProviderSourceEnabled;
		const refresh = vi.fn(async () => {});
		Object.assign(value.session.modelRuntime, { refresh });
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const list = await pageAt(value, 0);
		choose(list, "Octocode ");
		const octocode = await pageAt(value, 1);
		expect(textOf(octocode)).toContain("on (always)");
		expect(textOf(octocode)).not.toContain("Turn off");
		octocode.handleInput(ESC);
		const again = await pageAt(value, 2);
		choose(again, "Pi ");
		const pi = await pageAt(value, 3);
		expect(textOf(pi)).toContain("on (default)");
		choose(pi, "Turn off");
		const last = await pageAt(value, 4);
		expect(setProviderSourceEnabled).toHaveBeenCalledWith("pi", false);
		expect(refresh).toHaveBeenCalled();
		expect(value.showStatus).toHaveBeenLastCalledWith("Turned off Pi. Files are unchanged.");
		last.handleInput(ESC);
		await run;
	});

	it("offers replacement and removal next to model selection on the provider page", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		const output = textOf(page);
		for (const fact of [
			/Status +API key configured · OPENAI_API_KEY/,
			/Provider +enabled/,
			/Models +1 available · 1 in catalog/,
			/Definition +built-in/,
		]) {
			expect(output).toMatch(fact);
		}
		const actions = rows(page)
			.map((line) => line.trim())
			.filter((line) => /Choose a model|Sign in|API key$|Remove|Disable/.test(line) && !/Status|Models/.test(line));
		expect(actions.map((line) => line.replace(/^\s*[›▸]?\s*/, "").trim())).toEqual([
			"Choose a model for this chat",
			"Sign in — OpenAI account",
			"Replace API key",
			"Remove saved credential",
			"Disable provider",
		]);
		choose(page, "Replace API key");
		await run;
		expect(value.showApiKeyLoginDialog).toHaveBeenCalledWith("openai", "OpenAI", expect.any(Function));
	});

	it("disables a provider, warns when the chat runs on it, and offers enabling afterwards", async () => {
		const { host, value, runtime } = manager();
		const first = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Disable provider");
		await first;
		expect(runtime.setDisabledProviders).toHaveBeenCalledWith(["openai"]);
		expect(value.session.settingsManager.setDisabledProviders).toHaveBeenCalledWith(["openai"]);
		expect(value.showWarning).toHaveBeenCalledWith(expect.stringContaining("Switch with /model"));
		expect(value.updateAvailableProviderCount).toHaveBeenCalled();

		const second = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 1);
		expect(textOf(page)).toContain("openai".length ? "disabled" : "");
		choose(page, "Enable provider");
		await second;
		expect(runtime.setDisabledProviders).toHaveBeenLastCalledWith([]);
		expect(value.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Enabled OpenAI"));
	});

	it("lists custom provider files with paths and the defining models.json on a provider's page", async () => {
		const { host, value, runtime, setConfigDir } = manager();
		const dir = mkdtempSync(join(tmpdir(), "providers-"));
		try {
			writeFileSync(
				join(dir, "models.json"),
				JSON.stringify({
					providers: {
						local: { baseUrl: "http://localhost:1/v1", apiKey: "k", api: "openai-completions", models: [{ id: "m" }] },
					},
				}),
			);
			setConfigDir(dir);
			const local = { id: "local", name: "Local", auth: {} };
			runtime.getProviders = () => [local] as never;
			runtime.getProvider = () => local as never;
			const main = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
			const list = await pageAt(value, 0);
			expect(textOf(list)).toContain(`${join(dir, "models.json")} · defines local`);
			choose(list, "Octocode models.json");
			await pageAt(value, 1).catch(() => undefined);
			expect(value.showStatus).toHaveBeenLastCalledWith(expect.stringContaining(join(dir, "models.json")));
			(await pageAt(value, 1)).handleInput(ESC);
			await main;

			const detail = showProviderManager(host, "local", { sourceEnvironment: sourceEnvironment() });
			const page = await pageAt(value, 2);
			expect(textOf(page)).toContain(`Edit definition — Octocode models.json: ${join(dir, "models.json")}`);
			page.handleInput(ESC);
			await detail;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters model selection to the chosen provider", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "OpenAI", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Choose a model for this chat");
		await run;
		expect(value.showModelSelector).toHaveBeenCalledWith("openai/");
	});

	it("can cancel credential removal and explains remaining environment access after removal", async () => {
		const { host, value, runtime } = manager();
		value.showExtensionSelector.mockResolvedValueOnce("Cancel");
		await removeProviderCredential(host, "openai", "OpenAI");
		expect(value.showExtensionSelector.mock.calls[0][1][0]).toBe("Cancel");
		expect(runtime.logout).not.toHaveBeenCalled();
		value.showExtensionSelector.mockResolvedValueOnce("Remove credential — environment and models.json stay unchanged");
		await removeProviderCredential(host, "openai", "OpenAI");
		expect(runtime.logout).toHaveBeenCalledOnce();
		expect(value.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("Still configured: API key configured · OPENAI_API_KEY"),
		);
	});

	it("does not offer removal for environment-only credentials", async () => {
		const { host, value, runtime } = manager();
		runtime.listCredentials.mockResolvedValue([]);
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		expect(textOf(page)).not.toContain("Remove saved credential");
		expect(textOf(page)).toContain("Add API key");
		page.handleInput(ESC);
		await run;
	});

	it("keeps secret input masked during editing and horizontal scrolling", () => {
		const input = new Input({ secret: true });
		input.focused = true;
		input.handleInput("sk-never-render-this");
		input.handleInput("\x1b[D");
		input.handleInput("X");
		expect(input.getValue()).toContain("X");
		for (const width of [1, 10, 80]) {
			const output = stripAnsi(input.render(width).join("\n"));
			expect(output).not.toMatch(/sk-|never|this|X/);
		}
	});

	it("labels session overrides and offers clearing them independently of saved credentials", async () => {
		const { host, value, runtime } = manager();
		vi.spyOn(runtime, "getProviderAuthStatus").mockReturnValue({
			configured: true,
			source: "runtime",
			label: "session credential",
		});
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		const output = textOf(page);
		expect(output).toContain("Clear session API key override — keep saved credentials");
		expect(output).toContain("Update saved API key");
		expect(output).toContain("Remove saved and session credentials");
		expect(output).not.toMatch(/Remove saved credential/);
		page.handleInput(ESC);
		await run;
	});

	it("reports a failure in the provider manager reopened by a login dialog's back action", async () => {
		const { host, value, runtime } = manager();
		vi.spyOn(runtime, "getProviderAuthStatus").mockReturnValue({
			configured: true,
			source: "runtime",
			label: "session credential",
		});
		Object.assign(runtime, {
			removeRuntimeApiKey: vi.fn(async () => {
				throw new Error("auth store locked");
			}),
		});
		const first = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Update saved API key");
		await first;
		const back = value.showApiKeyLoginDialog.mock.calls[0][2] as () => void;
		runtime.listCredentials.mockRejectedValueOnce(new Error("never shown")).mockImplementationOnce(async () => {
			throw new Error("auth store locked");
		});
		// Login dialogs call onBack synchronously and never await it.
		back();
		await vi.waitFor(() => expect(value.showError).toHaveBeenCalled());
	});
});

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLYPH, Input, setKeybindings } from "@octocodeai/octocode-tui";
import type { ProviderPlan } from "@octocodeai/octocode-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getBuiltinCommand } from "../src/core/slash-commands.ts";
import { getLoginProviderOptions, showOAuthSelector } from "../src/modes/interactive/interactive-mode/login-flow.ts";
import { removeProviderCredential } from "../src/modes/interactive/interactive-mode/provider-actions.ts";
import { showProviderManager } from "../src/modes/interactive/interactive-mode/provider-manager.ts";
import { showSourcesPage } from "../src/modes/interactive/interactive-mode/provider-sources-page.ts";
import type { ProviderKind } from "../src/core/model-runtime/catalog.ts";
import { providerHealth, type ProviderHealth } from "../src/octocode/subagents/provider-health.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

// The one-request check is the network boundary: it records what a provider answered, as the real one does.
const answers = vi.hoisted(() => ({ error: undefined as string | undefined }));
vi.mock("../src/octocode/subagents/provider-health.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	checkProviders: vi.fn(
		async (_registry: unknown, entries: readonly { provider: string }[][], health: ProviderHealth) => {
			health.noteCheck(entries[0][0].provider, answers.error);
		},
	),
}));

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
	let hiddenModels: Record<string, string[]> = {};
	let configDir: string | undefined = sourceEnvironment().agentDir;
	const runtime = {
		getReloadError: () => undefined,
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
		getProviderPlan: vi.fn((_id: string): ProviderPlan | undefined => undefined),
		getPlanDisabledReason: (id: string) => runtime.getProviderPlan(id)?.disabled,
		getProviderDefinitionFile: () => undefined,
		readCredential: vi.fn(async () => undefined),
		getCredentialKind: vi.fn(async (): Promise<"account" | "subscription" | "key"> => "key"),
		getProviderKind: vi.fn((_id: string): ProviderKind => "API key"),
		hasConfiguredAuth: (id: string) => id === "openai",
		listCredentials: vi.fn(async () => [{ providerId: "openai", type: "api_key" }]),
		logout: vi.fn(async () => {}),
	};
	const value = {
		session: {
			modelRuntime: runtime,
			model: { provider: "openai", id: "one" },
			settingsManager: {
				saveDefaultModelSelection: vi.fn(),
				getProviderSources: () => ({}),
				getDisabledProviders: () => disabled,
				getHiddenModels: () => hiddenModels,
				setHiddenModels: vi.fn((hidden: Record<string, string[]>) => {
					hiddenModels = hidden;
				}),
				getExternalAgents: () => true,
				getEnabledExternalAgents: (): string[] | undefined => undefined,
				setDisabledProviders: vi.fn((ids: string[]) => {
					disabled = ids;
				}),
			},
		},
		showWarning: vi.fn(),
		showSelector: vi.fn(),
		showSelectorDialog: vi.fn(),
		showLoginDialog: vi.fn(),
		showApiKeyLoginDialog: vi.fn(),
		showAmbientAuthDialog: vi.fn(),
		showModelSelector: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
		ui: { requestRender: vi.fn(), stop: vi.fn(), start: vi.fn(), terminal: { rows: 40 } },
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
/** Escape the list that follows a provider page opened by name. */
async function closeList(value: Fixture["value"], index: number) {
	(await pageAt(value, index)).handleInput(ESC);
}
const rows = (page: { render(width: number): string[] }) =>
	textOf(page)
		.split("\n")
		.filter((line) => line.trim());

let home: string;
const sourceEnvironment = () => ({ home, env: {}, agentDir: join(home, ".octocode", "octocodecode") });

describe("provider setup flow", () => {
	it("names AWS profile and bearer-token configuration instead of promising an API-key-only flow", async () => {
		const { host, value, runtime } = manager();
		const cloud = {
			id: "cloud",
			name: "Cloud",
			auth: { apiKey: { name: "AWS credentials or bearer token", login: async () => ({}) } },
		};
		runtime.getProviders = () => [cloud] as never;
		runtime.getProvider = () => cloud;
		const run = showProviderManager(host, "cloud", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		expect(textOf(page)).toContain("Configure — AWS credentials or bearer token");
		choose(page, "Configure — AWS");
		await run;
		expect(value.showApiKeyLoginDialog).toHaveBeenCalledWith("cloud", "Cloud", expect.any(Function));
	});
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		home = mkdtempSync(join(tmpdir(), "providers-home-"));
		// A developer's installed `claude` must not change what the pages offer; tests that need it put one here.
		mkdirSync(join(home, "bin"));
		vi.stubEnv("PATH", join(home, "bin"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	/** A stand-in `claude` on PATH; Octocode must not offer to run it. */
	const installClaude = () => {
		const file = join(home, "bin", "claude");
		writeFileSync(file, "#!/bin/sh\nexit 9\n");
		chmodSync(file, 0o755);
	};

	it("offers only an API key for Anthropic, even with the Claude Code CLI installed", async () => {
		installClaude();
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "+ Provider");
		const picker = await pageAt(value, 1);
		for (const key of "anthropic") picker.handleInput(key);
		const anthropicRows = rows(picker).filter((line) => line.includes("Anthropic"));
		expect(anthropicRows).toEqual([expect.stringContaining("Anthropic · API key")]);
		expect(anthropicRows.join("\n")).not.toMatch(/subscription/i);
		picker.handleInput(ENTER);
		await run;
		// One method: the API key dialog opens directly, with no menu that could offer `claude setup-token`.
		await vi.waitFor(() =>
			expect(value.showApiKeyLoginDialog).toHaveBeenCalledWith("anthropic", "Anthropic", expect.any(Function)),
		);
		expect(value.showSelectorDialog).not.toHaveBeenCalled();
		expect(value.ui.stop).not.toHaveBeenCalled();
	});

	it("names provider access /providers and keeps each command under one name", () => {
		expect(getBuiltinCommand("providers")?.name).toBe("providers");
		// v20.0.1 (25685858) removed /github: GitHub access goes through `/octocode login`.
		for (const removed of ["login", "models", "github"]) expect(getBuiltinCommand(removed)).toBeUndefined();
	});

	it("keeps everyday access on the main page and source diagnostics on the advanced page", async () => {
		const { host, value } = manager();
		mkdirSync(join(home, ".codex"));
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		const output = textOf(page);
		const at = ["Ready", "External agents", "Add", "Advanced"].map((heading) =>
			output.search(new RegExp(`^ ${heading}$`, "m")),
		);
		expect(at.every((position) => position >= 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(output).not.toMatch(/^ Off$/m);
		expect(output.match(/OpenAI\b/g)?.length).toBeGreaterThanOrEqual(1);
		expect(output).toMatch(/OpenAI +API key · OPENAI_API_KEY · defined in built-in · 1 model +✓ ready/);
		expect(output).toContain("+ Provider");
		expect(output).toContain("+ From template");
		expect(output).toContain("+ External agent CLI");
		expect(output).not.toMatch(/^ Sources$/m);
		expect(output).toContain("not verified");
		choose(page, "Sources and custom models");
		const advanced = await pageAt(value, 1);
		const diagnostic = textOf(advanced);
		expect(diagnostic).toMatch(/Octocode .*auth\.json.* ✓ ready/);
		expect(diagnostic).toMatch(/Pi .*auth\.json.* ✓ ready/);
		expect(diagnostic).toMatch(/COPILOT_GITHUB_TOKEN .* off/);
		// Sign in with ChatGPT on OpenAI superseded the legacy Codex provider.
		expect(diagnostic).toMatch(/Codex CLI +~\/\.codex → sign in with OpenAI(?! Codex)/);
		expect(diagnostic).toContain("Octocode models.json");
		expect(textOf(advanced, 320)).toContain(join(sourceEnvironment().agentDir, "models.json"));
		expect(value.showLoginDialog).not.toHaveBeenCalled();
		advanced.handleInput(ESC);
		(await pageAt(value, 2)).handleInput(ESC);
		await run;
	});

	it("main page: a disabled provider moves to its own section and `e` toggles it", async () => {
		const { host, value, runtime } = manager();
		value.session.settingsManager.setDisabledProviders(["openai"]);
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const first = await pageAt(value, 0);
		expect(textOf(first)).toMatch(/^ Off$/m);
		expect(textOf(first)).toMatch(/OpenAI .* ○ off/);
		first.handleInput("e");
		const second = await pageAt(value, 1);
		expect(runtime.setDisabledProviders).toHaveBeenLastCalledWith([]);
		expect(textOf(second)).not.toMatch(/^ Off$/m);
		expect(value.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Enabled OpenAI"));
		second.handleInput(ESC);
		await run;
	});

	it("the Sign in row opens the sign-in picker, then that provider's sign-in", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		choose(page, "+ Provider");
		const picker = await pageAt(value, 1);
		expect(textOf(picker)).toContain("Sign in — choose a provider");
		// Providers with a sign-in come first, then API-key-only ones, each group by name.
		expect(rows(picker).filter((line) => /OpenAI|Anthropic/.test(line))).toEqual([
			expect.stringContaining("OpenAI · account sign-in or API key"),
			expect.stringContaining("OpenAI Codex · account sign-in"),
			expect.stringContaining("Anthropic · API key"),
		]);
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
		const codexRun = showSourcesPage({ host, reopen: vi.fn() }, [], sourceEnvironment());
		const codexPage = await pageAt(value, 0);
		expect(textOf(codexPage)).not.toContain("SECRET-NEVER-SHOWN");
		choose(codexPage, "Codex CLI");
		await codexRun;
		expect(value.showLoginDialog).toHaveBeenCalledWith("openai", "OpenAI", expect.any(Function));

		const claudeRun = showSourcesPage({ host, reopen: vi.fn() }, [], sourceEnvironment());
		const claudePage = await pageAt(value, 1);
		expect(textOf(claudePage)).toMatch(/Claude Code +~\/\.claude → add an API key for Anthropic/);
		choose(claudePage, "Claude Code");
		await claudeRun;
		expect(value.showApiKeyLoginDialog).toHaveBeenCalledWith("anthropic", "Anthropic", expect.any(Function));

		// An installed Claude Code CLI changes nothing: the row still offers the API key only.
		installClaude();
		const installedRun = showSourcesPage({ host, reopen: vi.fn() }, [], sourceEnvironment());
		const installedPage = await pageAt(value, 2);
		expect(textOf(installedPage)).toMatch(/Claude Code +~\/\.claude → add an API key for Anthropic/);
		choose(installedPage, "Claude Code");
		await installedRun;
		expect(value.showApiKeyLoginDialog).toHaveBeenCalledTimes(2);
		expect(value.showSelectorDialog).not.toHaveBeenCalled();
	});

	it("a source's page toggles Pi through settings and reapplies the sources; Octocode has no toggle", async () => {
		const { host, value } = manager();
		const settings = value.session.settingsManager as Record<string, unknown>;
		const setProviderSourceEnabled = vi.fn();
		settings.setProviderSourceEnabled = setProviderSourceEnabled;
		const refresh = vi.fn(async () => {});
		Object.assign(value.session.modelRuntime, { refresh });
		const run = showSourcesPage({ host, reopen: vi.fn() }, [], sourceEnvironment());
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

	it("shows a stored key that is a subscription token as subscription, in the list and on the page", async () => {
		const { host, value, runtime } = manager();
		runtime.getCredentialKind.mockResolvedValue("subscription");
		runtime.getProviderKind.mockReturnValue("subscription");
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const list = await pageAt(value, 0);
		expect(textOf(list)).toMatch(/OpenAI +subscription · OPENAI_API_KEY · defined in built-in · 1 model/);
		list.handleInput(ENTER);
		const detail = await pageAt(value, 1);
		expect(textOf(detail)).toMatch(/Status +✓ ready · subscription · OPENAI_API_KEY/);
		expect(textOf(detail)).not.toContain("✓ ready · API key");
		detail.handleInput(ESC);
		await pageAt(value, 2).then((page) => page.handleInput(ESC));
		await run;
	});

	it("shows a plain key as API key, in the list and on the page", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const list = await pageAt(value, 0);
		expect(textOf(list)).toMatch(/OpenAI +API key · OPENAI_API_KEY/);
		list.handleInput(ENTER);
		const detail = await pageAt(value, 1);
		expect(textOf(detail)).toMatch(/Status +✓ ready · API key/);
		detail.handleInput(ESC);
		await pageAt(value, 2).then((page) => page.handleInput(ESC));
		await run;
	});

	it("shows a plan's billing, terms and pause on the provider page", async () => {
		const { host, value, runtime } = manager();
		runtime.getProviderPlan.mockImplementation((id: string) =>
			id === "openai"
				? {
						billing: "plan",
						access: "direct",
						terms: "https://example.test/plan-terms",
						disabled: "The vendor paused this route.",
					}
				: undefined,
		);
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const list = await pageAt(value, 0);
		list.handleInput(ENTER);
		const detail = textOf(await pageAt(value, 1));
		expect(detail).toMatch(/Billing +Billed by plan/);
		expect(detail).toMatch(/Plan terms +https:\/\/example\.test\/plan-terms/);
		expect(detail).toMatch(/Paused +The vendor paused this route\./);
		(await pageAt(value, 1)).handleInput(ESC);
		await pageAt(value, 2).then((page) => page.handleInput(ESC));
		await run;
	});

	it("shows no plan facts for a provider without a plan", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const list = await pageAt(value, 0);
		list.handleInput(ENTER);
		const detail = await pageAt(value, 1);
		expect(textOf(detail)).not.toMatch(/Billing|Plan terms/);
		detail.handleInput(ESC);
		await pageAt(value, 2).then((page) => page.handleInput(ESC));
		await run;
	});

	it("Test runs the check for this provider and shows a pass", async () => {
		const { host, value } = manager();
		providerHealth.noteCheck("openai"); // a stale answer must not outlive the new check
		answers.error = undefined;
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Test —");
		await closeList(value, 1);
		await run;
		expect(value.showStatus).toHaveBeenCalledWith(expect.stringContaining("OpenAI: ✓ credential worked"));
		expect(value.showError).not.toHaveBeenCalled();
	});

	it("Test shows a failure with the key redacted", async () => {
		const { host, value } = manager();
		answers.error = "401 invalid x-api-key sk-ant-api03-secretsecretsecretsecret";
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Test —");
		await closeList(value, 1);
		await run;
		const shown = String(value.showError.mock.calls.at(-1)?.[0]);
		expect(shown).toContain("OpenAI: ✗ credential refused");
		expect(shown).toContain("401 invalid x-api-key");
		expect(shown).not.toContain("secretsecret");
		answers.error = undefined;
	});

	it("offers replacement and removal next to model selection on the provider page", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		const output = textOf(page);
		for (const fact of [
			/Status +✓ ready · API key · OPENAI_API_KEY/,
			/Provider +on/,
			/Models +1 available · 1 in catalog/,
			/Definition +built-in/,
		]) {
			expect(output).toMatch(fact);
		}
		const actions = rows(page)
			.map((line) => line.trim())
			.filter(
				(line) =>
					/Choose a model|Choose models|Sign in|API key$|Remove|Disable/.test(line) && !/Status|Models/.test(line),
			);
		expect(actions.map((line) => line.replace(/^\s*[›▸]?\s*/, "").trim())).toEqual([
			"Choose a model for this chat",
			"Choose models — tick which of this provider's models /model, Ctrl+P and subagents may use",
			"Sign in — OpenAI account",
			"Replace API key",
			"Remove saved credential",
			"Disable provider",
		]);
		choose(page, "Replace API key");
		await run;
		expect(value.showApiKeyLoginDialog).toHaveBeenCalledWith("openai", "OpenAI", expect.any(Function));
	});

	it("saves the models a user unticks on a provider's page and applies them to the session", async () => {
		const { host, value, runtime } = manager();
		runtime.getModels = () => [
			{ id: "one", name: "One", provider: "openai" },
			{ id: "two", name: "Two", provider: "openai" },
		];
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Choose models");
		const list = await pageAt(value, 1);
		expect(textOf(list)).toContain("OpenAI — choose models");
		list.handleInput(ENTER);
		list.handleInput("\x13");
		await vi.waitFor(() => expect(value.session.settingsManager.setHiddenModels).toHaveBeenCalled());
		const saved = value.session.settingsManager.setHiddenModels.mock.calls[0][0];
		expect(Object.values(saved)[0]).toHaveLength(1);
		list.handleInput(ESC);
		await closeList(value, 2);
		await run;
	});

	it("sets a default provider from its page without changing the current chat", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Set as default provider for new chats");
		await vi.waitFor(() =>
			expect(value.session.settingsManager.saveDefaultModelSelection).toHaveBeenCalledWith("openai", undefined),
		);
		expect(value.showModelSelector).not.toHaveBeenCalled();
		await closeList(value, 1);
		await run;
	});

	it("disables a provider, warns when the chat runs on it, and offers enabling afterwards", async () => {
		const { host, value, runtime } = manager();
		const first = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Disable provider");
		await closeList(value, 1);
		await first;
		expect(runtime.setDisabledProviders).toHaveBeenCalledWith(["openai"]);
		expect(value.session.settingsManager.setDisabledProviders).toHaveBeenCalledWith(["openai"]);
		expect(value.showWarning).toHaveBeenCalledWith(expect.stringContaining("Switch with /model"));
		expect(value.updateAvailableProviderCount).toHaveBeenCalled();

		const second = showProviderManager(host, "openai", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 2);
		expect(textOf(page)).toContain("off · hidden from /model");
		choose(page, "Enable provider");
		await closeList(value, 3);
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
			const main = showSourcesPage({ host, reopen: vi.fn() }, [], sourceEnvironment());
			const list = await pageAt(value, 0);
			// Exact path checks need a wide viewport under long isolated temporary prefixes.
			expect(textOf(list, 320)).toContain(`${join(dir, "models.json")} · defines local`);
			choose(list, "Octocode models.json");
			await pageAt(value, 1).catch(() => undefined);
			expect(value.showStatus).toHaveBeenLastCalledWith(expect.stringContaining(join(dir, "models.json")));
			(await pageAt(value, 1)).handleInput(ESC);
			await main;

			const detail = showProviderManager(host, "local", { sourceEnvironment: sourceEnvironment() });
			const page = await pageAt(value, 2);
			expect(textOf(page, 320)).toContain(`Show definition file — Octocode models.json: ${join(dir, "models.json")}`);
			page.handleInput(ESC);
			await closeList(value, 3);
			await detail;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says a saved credential whose provider is no longer defined cannot be used", async () => {
		const { host, value, runtime } = manager();
		runtime.listCredentials.mockResolvedValue([
			{ providerId: "openai", type: "api_key" },
			{ providerId: "gone-gateway", type: "api_key" },
		]);
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		expect(textOf(page)).toContain("Needs attention");
		expect(textOf(page)).toMatch(
			/gone-gateway +credential in .* but no provider defines it · remove the credential, or define the provider in .*✗ broken/,
		);
		expect(textOf(page)).not.toContain("Signed in");
		page.handleInput(ESC);
		await run;
	});

	it("+ External agent CLI lists the vendor CLIs, and + Provider offers none of them", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const list = await pageAt(value, 0);
		let offered: readonly string[] = [];
		value.showSelectorDialog.mockImplementation(async (_title: string, labels: string[]) => {
			offered = labels;
			return labels.find((label) => label.startsWith("Gemini CLI"));
		});
		choose(list, "+ External agent CLI");
		const page = await pageAt(value, 1);
		expect(offered.find((label) => label.startsWith("Claude Code"))).toMatch(
			/external agent · its own harness · Claude Pro\/Max subscription/,
		);
		expect(offered.find((label) => label.startsWith("Gemini CLI"))).toMatch(
			/external agent · its own harness · Google AI Pro\/Ultra subscription/,
		);
		expect(textOf(page)).toContain("Gemini CLI — not connected");
		expect(textOf(page)).toMatch(/external agent: its own harness runs each task/);
		expect(value.showLoginDialog).not.toHaveBeenCalled();
		page.handleInput(ESC);
		(await pageAt(value, 2)).handleInput(ESC);
		await run;
	});

	it("+ Provider lists providers only, not vendor CLIs", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "+ Provider");
		const picker = await pageAt(value, 1);
		expect(textOf(picker)).not.toMatch(/external agent/);
		picker.handleInput(ESC);
		(await pageAt(value, 2)).handleInput(ESC);
		await run;
	});

	it("the sign-in picker names subscription and account sign-ins and finds them by the sign-in's name", async () => {
		const { host, value } = manager();
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "+ Provider");
		const picker = await pageAt(value, 1);
		expect(textOf(picker)).toMatch(/OpenAI · account sign-in or API key/);
		for (const key of "chatgpt") picker.handleInput(key);
		expect(rows(picker).filter((line) => /OpenAI|Anthropic/.test(line))).toEqual([
			expect.stringContaining("OpenAI Codex · account sign-in"),
		]);
		// Esc clears the search first, then cancels back to the provider page.
		picker.handleInput(ESC);
		expect(rows(picker).filter((line) => /Anthropic/.test(line)).length).toBeGreaterThan(0);
		picker.handleInput(ESC);
		(await pageAt(value, 2)).handleInput(ESC);
		await run;
	});

	it("/logout [provider] opens the saved-credential picker filtered by the provider and labels rows as saved", async () => {
		const { host, value } = manager();
		await showOAuthSelector(host, "logout", "open");
		const picker = await pageAt(value, 0);
		expect(textOf(picker)).toContain(" ⌕ open");
		expect(textOf(picker)).toMatch(/OpenAI · saved API key/);
		expect(textOf(picker)).not.toContain("configured");
		picker.handleInput(ESC);
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
		value.showSelectorDialog.mockResolvedValueOnce("Cancel");
		await removeProviderCredential(host, "openai", "OpenAI");
		expect(value.showSelectorDialog.mock.calls[0][1][0]).toBe("Cancel");
		expect(runtime.logout).not.toHaveBeenCalled();
		value.showSelectorDialog.mockResolvedValueOnce("Remove credential — environment and models.json stay unchanged");
		await removeProviderCredential(host, "openai", "OpenAI");
		expect(runtime.logout).toHaveBeenCalledOnce();
		expect(value.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("Still configured: API key · OPENAI_API_KEY"),
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
		await closeList(value, 1);
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
		await closeList(value, 1);
		await run;
	});

	it("External agents: a row per runner; Sign in hands the terminal to the vendor's own login, then checks again", async () => {
		// A stand-in Claude Code: its status reads a file that its own login writes; Octocode reads neither.
		const marker = join(home, "signed-in");
		writeFileSync(
			join(home, "bin", "claude"),
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then echo "2.1.400 (Claude Code)"; exit 0; fi',
				`if [ "$1 $2" = "auth login" ]; then : > "${marker}"; exit 0; fi`,
				`if [ -f "${marker}" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0; fi`,
				`echo '{"loggedIn": false}'; exit 1`,
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(join(home, "bin", "claude-agent-acp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		mkdirSync(sourceEnvironment().agentDir, { recursive: true });
		const { host, value } = manager();
		const setExternalAgents = vi.fn();
		const setEnabledExternalAgents = vi.fn();
		// The user turned the setting off before: connecting the runner leaves that choice alone.
		Object.assign(value.session.settingsManager, {
			getExternalAgents: () => false,
			getGlobalSettings: () => ({ externalAgents: false }),
			setEnabledExternalAgents,
			setExternalAgents,
		});
		const environment = { ...sourceEnvironment(), env: { PATH: join(home, "bin") } };
		const run = showProviderManager(host, "", { sourceEnvironment: environment });
		const page = await pageAt(value, 0);
		// The section is the page's last: its rows show once the selection reaches them.
		for (let step = 0; step < 40 && !selectedLine(page).includes("Claude Code"); step++) page.handleInput(DOWN);
		const output = textOf(page);
		expect(output).toMatch(/^ External agents$/m);
		// The list starts nothing: the runner is checked when its own page opens.
		expect(output).toMatch(/Claude Code +not ready · CLI · not checked · open to check +⚠ needs action/);
		expect(output).toMatch(/Codex CLI +CLI · not installed · codex not on PATH +○ off/);
		page.handleInput(ENTER);
		await vi.waitFor(() => expect(value.showSelector.mock.calls.length).toBeGreaterThan(1), { timeout: 15_000 });
		const detail = await pageAt(value, 1);
		expect(textOf(detail)).toContain("never reads its credentials");
		expect(textOf(detail)).toMatch(/Sign-in +signed out/);
		choose(detail, "Sign in with Claude Code's own login (claude auth login)");
		await vi.waitFor(
			() => expect(value.showStatus).toHaveBeenCalledWith("Claude Code: signed in · claude.ai · plan."),
			{
				timeout: 15_000,
			},
		);
		expect(value.ui.stop).toHaveBeenCalled();
		expect(value.ui.start).toHaveBeenCalled();
		const again = await pageAt(value, 2);
		for (let step = 0; step < 40 && !selectedLine(again).includes("Claude Code"); step++) again.handleInput(DOWN);
		expect(textOf(again)).toMatch(
			/Claude Code +CLI · 2\.1\.400 · signed in · claude\.ai · plan · off for tasks +○ off/,
		);
		expect(setExternalAgents).not.toHaveBeenCalled();
		again.handleInput(ENTER);
		choose(await pageAt(value, 3), "Enable this CLI for agent tasks");
		await vi.waitFor(() => expect(setExternalAgents).toHaveBeenCalledWith(true));
		expect(setEnabledExternalAgents).toHaveBeenCalledWith(["claude-code"]);
		(await pageAt(value, 4)).handleInput(ESC);
		await run;
	});

	/** A stand-in Claude Code already signed in, with its ACP adapter: connected once checked. */
	const installSignedInClaude = () => {
		writeFileSync(
			join(home, "bin", "claude"),
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then echo "2.1.400 (Claude Code)"; exit 0; fi',
				`echo '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0`,
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(join(home, "bin", "claude-agent-acp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		mkdirSync(sourceEnvironment().agentDir, { recursive: true });
	};

	it.each([undefined, false])(
		"External agents: Check again preserves externalAgents=%s without a setting write",
		async (initial) => {
			installSignedInClaude();
			const { host, value } = manager();
			let externalAgents: boolean | undefined = initial;
			const globalSettings = () => (externalAgents === undefined ? {} : { externalAgents });
			const setExternalAgents = vi.fn((enabled: boolean) => {
				externalAgents = enabled;
			});
			Object.assign(value.session.settingsManager, {
				getExternalAgents: () => externalAgents === true,
				getGlobalSettings: globalSettings,
				setExternalAgents,
			});
			const environment = { ...sourceEnvironment(), env: { PATH: join(home, "bin") } };
			const run = showProviderManager(host, "", { sourceEnvironment: environment });
			choose(await pageAt(value, 0), "Claude Code");
			await vi.waitFor(() => expect(value.showSelector.mock.calls.length).toBeGreaterThan(1), { timeout: 15_000 });
			choose(await pageAt(value, 1), "Check again");
			await vi.waitFor(
				() => expect(value.showStatus).toHaveBeenCalledWith("Claude Code: signed in · claude.ai · plan."),
				{ timeout: 15_000 },
			);
			expect(setExternalAgents).not.toHaveBeenCalled();
			expect(externalAgents).toBe(initial);
			expect(globalSettings()).toEqual(initial === undefined ? {} : { externalAgents: false });
			const again = await pageAt(value, 2);
			for (let step = 0; step < 40 && !selectedLine(again).includes("Claude Code"); step++) again.handleInput(DOWN);
			expect(textOf(again)).toMatch(
				/Claude Code +CLI · 2\.1\.400 · signed in · claude\.ai · plan · off for tasks +○ off/,
			);
			again.handleInput(ESC);
			await run;
		},
	);

	it("External agents: a connected runner with externalAgents off says so on the main page", async () => {
		installSignedInClaude();
		const { host, value } = manager();
		Object.assign(value.session.settingsManager, { getExternalAgents: () => false });
		const environment = { ...sourceEnvironment(), env: { PATH: join(home, "bin") } };
		// The first visit checks the runner; the list shows that answer from then on.
		const first = showProviderManager(host, "", { sourceEnvironment: environment });
		choose(await pageAt(value, 0), "Claude Code");
		await vi.waitFor(() => expect(value.showSelector.mock.calls.length).toBeGreaterThan(1), { timeout: 15_000 });
		(await pageAt(value, 1)).handleInput(ESC);
		const list = await pageAt(value, 2);
		for (let step = 0; step < 40 && !selectedLine(list).includes("Claude Code"); step++) list.handleInput(DOWN);
		expect(textOf(list)).toMatch(/Claude Code +CLI · 2\.1\.400 · signed in · claude\.ai · plan · off for tasks +○ off/);
		list.handleInput(ESC);
		await first;
	});

	it("a saved Claude subscription token lists Anthropic as refused, and its page says why", async () => {
		const { host, value, runtime } = manager();
		runtime.listCredentials.mockResolvedValue([
			{ providerId: "openai", type: "api_key" },
			{ providerId: "anthropic", type: "api_key" },
		]);
		Object.assign(runtime, {
			getAuth: vi.fn(async (id: string) =>
				id === "anthropic" ? { auth: { apiKey: "sk-ant-oat01-test" }, source: "stored credential" } : undefined,
			),
		});
		const run = showProviderManager(host, "", { sourceEnvironment: sourceEnvironment() });
		const list = await pageAt(value, 0);
		expect(textOf(list, 220)).toMatch(
			/Anthropic +Claude subscription token refused · use Claude Code under External agents.* · 0 models.*✗ broken/,
		);
		expect(textOf(list, 220)).not.toContain("sk-ant-oat01-test");
		choose(list, "Anthropic");
		const detail = await pageAt(value, 1);
		expect(textOf(detail, 260)).toMatch(
			/Status +✗ broken · Claude subscription token refused\s+Next step +use Claude Code under External agents/,
		);
		detail.handleInput(ESC);
		await pageAt(value, 2).then((page) => page.handleInput(ESC));
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

	it.each(["codex", "runner:opencode"])("opens the external CLI directly with /providers %s", async (query) => {
		const { host, value } = manager();
		const run = showProviderManager(host, query, { sourceEnvironment: sourceEnvironment() });
		const page = await pageAt(value, 0);
		expect(textOf(page)).toContain(query === "codex" ? "Codex CLI —" : "OpenCode —");
		expect(textOf(page)).toContain("own tools and sign-in");
		page.handleInput(ESC);
		await closeList(value, 1);
		await run;
		expect(value.showLoginDialog).not.toHaveBeenCalled();
	});

	it("enables one CLI through its page without changing the default model or other selections", async () => {
		const { host, value } = manager();
		let selected = ["custom"];
		let enabled = false;
		Object.assign(value.session.settingsManager, {
			getExternalAgents: () => enabled,
			getEnabledExternalAgents: () => selected,
			setEnabledExternalAgents: (ids: string[]) => {
				selected = ids;
			},
			setExternalAgents: (next: boolean) => {
				enabled = next;
			},
		});
		const run = showProviderManager(host, "codex", { sourceEnvironment: sourceEnvironment() });
		choose(await pageAt(value, 0), "Enable this CLI for agent tasks");
		await closeList(value, 1);
		await run;
		expect(selected).toEqual(["custom", "codex"]);
		expect(enabled).toBe(true);
		expect(value.session.model).toEqual({ provider: "openai", id: "one" });
		expect(value.showModelSelector).not.toHaveBeenCalled();
		expect(value.showStatus).toHaveBeenCalledWith(expect.stringContaining("/reload"));
	});
});

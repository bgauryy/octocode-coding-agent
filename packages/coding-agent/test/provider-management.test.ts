import { Input, setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getBuiltinCommand } from "../src/core/slash-commands.ts";
import { getLoginProviderOptions } from "../src/modes/interactive/interactive-mode/login-flow.ts";
import {
	removeProviderCredential,
	showProviderManager,
} from "../src/modes/interactive/interactive-mode/provider-manager.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function manager() {
	const provider = {
		id: "openai",
		name: "OpenAI",
		auth: {
			apiKey: { name: "API key", login: async () => ({ type: "api_key", key: "test" }) },
			oauth: { name: "OpenAI account", login: async () => ({}) },
		},
	};
	const runtime = {
		getProviders: () => [provider],
		getProvider: (id: string) => (id === provider.id ? provider : undefined),
		getAvailableSnapshot: () => [{ provider: "openai", id: "one" }],
		getProviderAuthStatus: () => ({ configured: true, source: "environment", label: "OPENAI_API_KEY" }),
		isUsingOAuth: () => false,
		hasConfiguredAuth: () => true,
		listCredentials: vi.fn(async () => [{ providerId: "openai", type: "api_key" }]),
		logout: vi.fn(async () => {}),
	};
	const value = {
		session: { modelRuntime: runtime },
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
	return { host: createFakeHost(value), value, runtime };
}

describe("provider setup flow", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("names provider access /login and keeps each command under one name", () => {
		expect(getBuiltinCommand("login")?.name).toBe("login");
		expect(getBuiltinCommand("login")?.description).toContain("Connect AI providers");
		expect(getBuiltinCommand("github")?.description).toContain("/login");
		for (const removed of ["providers", "models"]) expect(getBuiltinCommand(removed)).toBeUndefined();
		expect(getBuiltinCommand("modelsettings")?.description).toContain("routing");
		expect(getBuiltinCommand("github")?.description).toContain("code-search");
	});

	it("shows each provider once with its source and model count, plus Pi", async () => {
		const { host, value } = manager();
		await showProviderManager(host);
		const { component } = value.showSelector.mock.calls[0][0](vi.fn());
		const output = stripAnsi(component.render(140).join("\n"));
		expect(output.match(/OpenAI/g)).toHaveLength(1);
		expect(output).toContain("OPENAI_API_KEY");
		expect(output).toContain("1 models");
		expect(output).toContain("Pi");
		expect(output).toContain("not verified");
		expect(value.showLoginDialog).not.toHaveBeenCalled();
	});

	it("offers replacement and removal next to model selection", async () => {
		const { host, value } = manager();
		value.showExtensionSelector.mockResolvedValue("Replace API key");
		await showProviderManager(host, "openai");
		expect(value.showExtensionSelector.mock.calls[0][1]).toEqual([
			"Choose a model for this chat",
			"Sign in — OpenAI account",
			"Replace API key",
			"Remove saved credential",
		]);
		expect(value.showApiKeyLoginDialog).toHaveBeenCalledWith("openai", "OpenAI", expect.any(Function));
	});

	it("filters model selection to the chosen provider", async () => {
		const { host, value } = manager();
		value.showExtensionSelector.mockResolvedValue("Choose a model for this chat");
		await showProviderManager(host, "OpenAI");
		expect(value.showModelSelector).toHaveBeenCalledWith("openai/");
	});

	it("can cancel credential removal and explains remaining environment access after removal", async () => {
		const { host, value, runtime } = manager();
		value.showExtensionSelector.mockResolvedValueOnce("Cancel");
		await removeProviderCredential(host, "openai", "OpenAI");
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
		await showProviderManager(host, "openai");
		expect(value.showExtensionSelector.mock.calls[0][1]).not.toContain("Remove saved credential");
		expect(value.showExtensionSelector.mock.calls[0][1]).toContain("Add API key");
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
		await showProviderManager(host, "openai");
		const actions = value.showExtensionSelector.mock.calls[0][1];
		expect(actions).toContain("Clear session API key override — keep saved credentials");
		expect(actions).toContain("Update saved API key");
		expect(actions).toContain("Remove saved and session credentials");
		expect(actions).not.toContain("Remove saved credential");
	});
});

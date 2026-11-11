import type { AuthInteraction } from "@octocodeai/octocode-ai";
import { CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL } from "@octocodeai/octocode-ai/api/anthropic-messages/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPastedKey } from "../src/modes/interactive/interactive-mode/pasted-key.ts";

/** The answers the fake dialog gives: the pasted key, then the label chosen in a selector. */
const script = vi.hoisted(() => ({ key: "", choice: undefined as string | undefined, selectors: [] as string[] }));

vi.mock("../src/modes/interactive/components/login-dialog.ts", () => ({
	LoginDialogComponent: class {
		signal = new AbortController().signal;
		showInfo() {}
		showDetails() {}
		showProgress() {}
		showPrompt() {
			return Promise.resolve(script.key);
		}
	},
}));

vi.mock("../src/modes/interactive/components/extension-selector.ts", () => ({
	ExtensionSelectorComponent: class {
		constructor(message: string, labels: string[], onSelect: (label: string) => void, onCancel: () => void) {
			script.selectors.push(message);
			const label = labels.find((entry) => entry === script.choice);
			queueMicrotask(() => (label ? onSelect(label) : onCancel()));
		}
	},
}));

vi.mock("../src/core/auth-storage/keychain.ts", () => ({ detectKeychain: () => undefined }));

const { showApiKeyLoginDialog } = await import("../src/modes/interactive/interactive-mode/login-dialogs.ts");

const NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"github-copilot": "GitHub Copilot",
};

/** A host whose runtime login asks for the key once and saves what it was given. */
function host() {
	const saved: string[] = [];
	const value = {
		session: {
			modelRuntime: {
				getProvider: (id: string) => (NAMES[id] ? { name: NAMES[id] } : undefined),
				login: async (_id: string, _method: string, interaction: AuthInteraction) => {
					saved.push(await interaction.prompt({ type: "secret", message: "Enter the key" }));
				},
			},
		},
		editor: {},
		editorContainer: { clear() {}, addChild() {} },
		programStatus: { setBlocked() {} },
		settingsManager: { getOrCreateDeviceId: () => "device" },
		ui: { setFocus() {}, requestRender() {} },
		completeProviderAuthentication: vi.fn(async () => {}),
		showError: vi.fn(),
	};
	return { value, saved };
}

afterEach(() => {
	script.choice = undefined;
	script.selectors.length = 0;
});

describe("checkPastedKey", () => {
	it.each([
		["anthropic", "sk-ant-oat01-abc"],
		["openai", "sk-ant-oat01-abc"],
		["anthropic", "  sk-ant-oat01-abc\n"],
	])("refuses a Claude subscription token pasted for %s", (provider, key) => {
		expect(checkPastedKey(provider, key)).toEqual({ kind: "refuse", message: CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL });
	});

	it.each([
		["openai", "sk-ant-api03-abc", "anthropic"],
		["openai", "ghu_abc", "github-copilot"],
		["anthropic", "gho_abc", "github-copilot"],
		["anthropic", "sk-proj-abc", "openai"],
		["openrouter", "sk-proj-abc", "openai"],
		["openai", "sk-or-v1-abc", "openrouter"],
		["openai", "AIzaabc", "google"],
	])("flags a key pasted for %s that belongs to another provider", (provider, key, owner) => {
		expect(checkPastedKey(provider, key)).toEqual({ kind: "mismatch", owner });
	});

	it.each([
		["anthropic", "sk-ant-api03-abc"],
		["openai", "sk-proj-abc"],
		["google-vertex", "AIzaabc"],
		// A bare `sk-` is shared by many providers, so it never claims one.
		["deepseek", "sk-abc"],
		["openai", "sk-abc"],
		["my-gateway", "unprefixed-key"],
	])("accepts a key pasted for %s whose prefix fits", (provider, key) => {
		expect(checkPastedKey(provider, key)).toEqual({ kind: "ok" });
	});
});

describe("API key dialog checks the pasted key before saving", () => {
	it("refuses a Claude subscription token, saves nothing and names the external agent, never the key", async () => {
		script.key = "sk-ant-oat01-secret-value";
		const { value, saved } = host();
		await showApiKeyLoginDialog(value as never, "anthropic", "Anthropic");
		expect(saved).toEqual([]);
		expect(value.showError).toHaveBeenCalledWith(
			`Failed to save API key for Anthropic: ${CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL}`,
		);
		expect(JSON.stringify(value.showError.mock.calls)).not.toContain("secret-value");
		expect(value.completeProviderAuthentication).not.toHaveBeenCalled();
	});

	it("asks before saving a key that belongs to another provider, naming it, and saves nothing on cancel", async () => {
		script.key = "ghu_secret-value";
		const { value, saved } = host();
		const back = vi.fn();
		await showApiKeyLoginDialog(value as never, "openai", "OpenAI", back);
		expect(script.selectors).toEqual([
			"This looks like a key for GitHub Copilot, not OpenAI. Save it for OpenAI anyway?",
		]);
		expect(script.selectors.join()).not.toContain("secret-value");
		expect(saved).toEqual([]);
		expect(back).toHaveBeenCalledOnce();
		expect(value.showError).not.toHaveBeenCalled();
	});

	it("saves a mismatched key when the user confirms", async () => {
		script.key = "sk-ant-api03-key";
		script.choice = "Save it for OpenAI";
		const { value, saved } = host();
		await showApiKeyLoginDialog(value as never, "openai", "OpenAI");
		expect(script.selectors).toHaveLength(1);
		expect(saved).toEqual(["sk-ant-api03-key"]);
		expect(value.completeProviderAuthentication).toHaveBeenCalledWith("openai", "OpenAI", "api_key");
	});

	it("saves a key that fits its provider without asking", async () => {
		script.key = "sk-ant-api03-key";
		const { value, saved } = host();
		await showApiKeyLoginDialog(value as never, "anthropic", "Anthropic");
		expect(script.selectors).toEqual([]);
		expect(saved).toEqual(["sk-ant-api03-key"]);
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { plaintextStorageNotice } from "../src/core/auth-storage/keychain-login.ts";

const shown = vi.hoisted(() => ({ info: [] as string[] }));

vi.mock("../src/modes/interactive/components/login-dialog.ts", () => ({
	LoginDialogComponent: class {
		signal = new AbortController().signal;
		showInfo(message: string) {
			shown.info.push(message);
		}
		showDetails() {}
		showProgress() {}
		showPrompt() {
			return Promise.resolve("sk-test-key");
		}
	},
}));

vi.mock("../src/core/auth-storage/keychain.ts", () => ({ detectKeychain: () => undefined }));

const { showApiKeyLoginDialog, showLoginDialog } =
	await import("../src/modes/interactive/interactive-mode/login-dialogs.ts");

function host() {
	return {
		session: {
			modelRuntime: {
				getProvider: () => ({ name: "Cloud" }),
				login: async (_id: string, method: string, interaction: AuthInteraction) => {
					if (method === "api_key") await interaction.prompt({ type: "secret", message: "Enter the key" });
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
}

let agentDir: string;
const savedAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "octocode-plaintext-notice-"));
	process.env[ENV_AGENT_DIR] = agentDir;
	shown.info.length = 0;
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("saving a credential with no system keychain", () => {
	it("names the plaintext file in the notice", () => {
		expect(plaintextStorageNotice("api_key", "/home/me/auth.json")).toBe(
			"No system keychain is available. API keys are stored as plain text in /home/me/auth.json, created with owner-only permissions.",
		);
		expect(plaintextStorageNotice("oauth", "/home/me/auth.json")).toContain("Sign-in tokens");
	});

	it("an API key login shows the notice with the real auth.json path before the key is asked", async () => {
		await showApiKeyLoginDialog(host() as never, "cloud", "Cloud");
		expect(shown.info).toEqual([plaintextStorageNotice("api_key", join(agentDir, "auth.json"))]);
	});

	it("an account sign-in shows it too, for its tokens", async () => {
		await showLoginDialog(host() as never, "cloud", "Cloud");
		expect(shown.info).toEqual([plaintextStorageNotice("oauth", join(agentDir, "auth.json"))]);
	});
});

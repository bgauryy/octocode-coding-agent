import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { GithubAuthOptions, GithubStatus } from "../../mcp/src/presets/octocode/github-auth.ts";
import { handleGithubCommand } from "../src/modes/interactive/interactive-mode/github-command.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("../../common/src/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const ESC = "\x1b";
const signedIn: GithubStatus = {
	authenticated: true,
	verification: "verified",
	username: "octo",
	hostname: "github.com",
	tokenSource: "octocode-storage",
};
const signedOut: GithubStatus = {
	...signedIn,
	authenticated: false,
	verification: "none",
	username: null,
	tokenSource: "none",
};

function host() {
	const shown: { render(width: number): string[]; handleInput?(data: string): void }[] = [];
	const editor = { render: () => [] };
	return {
		shown,
		footerDataProvider: { setGithubStatusText: vi.fn() },
		editor,
		editorContainer: { clear: vi.fn(() => (shown.length = 0)), addChild: vi.fn((child) => shown.push(child)) },
		ui: { setFocus: vi.fn(), requestRender: vi.fn() } as unknown as TUI,
		programStatus: { setBlocked: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
	};
}

/** A runner whose login waits for `finish`, after showing a device code. */
function runner(status: GithubStatus, after: GithubStatus = signedIn) {
	let finish: (() => void) | undefined;
	let loggedIn = false;
	const run = vi.fn(async (action: string, options: GithubAuthOptions = {}) => {
		if (action === "status") return loggedIn ? after : status;
		if (action === "logout") return { loggedOut: true, hostname: "github.com", home: "/h" };
		options.onDeviceCode?.({ verificationUri: "https://github.com/login/device", userCode: "ABCD-1234" });
		await new Promise<void>((resolve, reject) => {
			finish = resolve;
			options.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")));
		});
		loggedIn = true;
		return { success: true, action: "login", hostname: "github.com", username: "octo" };
	});
	return { run, finish: () => finish?.() };
}

const text = (target: ReturnType<typeof host>) =>
	stripAnsi(target.shown.map((c) => c.render(80).join("\n")).join("\n"));

describe("/github", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("shows who is signed in without starting a login", async () => {
		const target = host();
		const { run } = runner(signedIn);
		await handleGithubCommand(target as never, "", run as never);
		expect(target.showStatus).toHaveBeenCalledWith("GitHub: signed in as octo on github.com (Octocode login)");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("signs in when not signed in: shows the device code, then restores the editor", async () => {
		const target = host();
		const { run, finish } = runner(signedOut);
		const done = handleGithubCommand(target as never, "", run as never);
		await vi.waitFor(() => expect(text(target)).toContain("Enter code: ABCD-1234"));
		expect(text(target)).toContain("https://github.com/login/device");
		expect(target.programStatus.setBlocked).toHaveBeenCalledWith("login", expect.objectContaining({ kind: "auth" }));
		finish();
		await done;
		expect(target.showStatus).toHaveBeenCalledWith("Signed in to GitHub as octo on github.com");
		expect(target.shown).toEqual([target.editor]);
		expect(target.programStatus.setBlocked).toHaveBeenLastCalledWith("login", undefined);
	});

	it("warns when an environment token still takes priority after login", async () => {
		const target = host();
		const { run, finish } = runner(signedOut, { ...signedIn, tokenSource: "env:GITHUB_TOKEN" });
		const done = handleGithubCommand(target as never, "login", run as never);
		await vi.waitFor(() => expect(text(target)).toContain("ABCD-1234"));
		finish();
		await done;
		expect(target.showWarning).toHaveBeenCalledWith(
			"GITHUB_TOKEN is set and takes priority over this login until you unset it.",
		);
	});

	it("cancels a pending login with Esc", async () => {
		const target = host();
		const { run } = runner(signedOut);
		const done = handleGithubCommand(target as never, "login", run as never);
		await vi.waitFor(() => expect(text(target)).toContain("ABCD-1234"));
		target.shown[0].handleInput?.(ESC);
		await done;
		expect(target.showStatus).toHaveBeenCalledWith("GitHub login cancelled");
		expect(target.showError).not.toHaveBeenCalled();
		expect(target.shown).toEqual([target.editor]);
	});

	it("reports an account that was already signed in", async () => {
		const target = host();
		const run = vi.fn(async (action: string) =>
			action === "login"
				? { success: true, action: "none", alreadyAuthenticated: true, hostname: "github.com", username: "octo" }
				: signedIn,
		);
		await handleGithubCommand(target as never, "login", run as never);
		expect(target.showStatus).toHaveBeenCalledWith(
			"Already signed in to GitHub as octo on github.com. Run /github logout to switch accounts.",
		);
	});

	it("asks before signing out, signs out, and rejects unknown arguments", async () => {
		const target = host();
		const { run } = runner(signedIn);
		target.showExtensionConfirm.mockResolvedValueOnce(false);
		await handleGithubCommand(target as never, "logout", run as never);
		expect(target.showStatus).toHaveBeenLastCalledWith("Still signed in to GitHub.");
		await handleGithubCommand(target as never, "logout", run as never);
		expect(target.showStatus).toHaveBeenCalledWith(
			"Signed out of GitHub on github.com. Environment and gh CLI credentials are unchanged.",
		);
		await handleGithubCommand(target as never, "token", run as never);
		expect(target.showWarning).toHaveBeenCalledWith("Usage: /github [status|login|logout]");
	});

	it("shows CLI failures as errors", async () => {
		const target = host();
		const run = vi.fn(async () => {
			throw new Error("Octocode native CLI is missing");
		});
		await handleGithubCommand(target as never, "status", run);
		expect(target.showError).toHaveBeenCalledWith("GitHub: Octocode native CLI is missing");
	});
});

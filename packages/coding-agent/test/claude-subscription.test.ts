import { describe, expect, it, vi } from "vitest";
import {
	findSetupToken,
	signInWithClaudeSubscription,
} from "../src/modes/interactive/interactive-mode/claude-subscription.ts";

const token = `sk-ant-oat01-${"Zq9_x-Wm3K".repeat(9)}abcdeAA`;

describe("findSetupToken", () => {
	it("reads a token printed on one line between colors", () => {
		expect(findSetupToken(`\x1b[2K\x1b[1G\x1b[32m${token}\x1b[39m\r\n\r\nStore this token securely\r\n`)).toBe(token);
	});

	it("rejoins a token the terminal UI wrapped across lines, and stops at the next words", () => {
		const printed = `${token.slice(0, 40)}\r\n${token.slice(40, 80)}\r\n${token.slice(80)}\r\n\r\nStore it\r\n`;
		expect(findSetupToken(printed)).toBe(token);
	});

	it("takes the last token when the UI redrew the screen", () => {
		const older = `sk-ant-oat01-${"o".repeat(95)}`;
		expect(findSetupToken(`${older}\r\n\x1b[3A\x1b[J${token}\r\n`)).toBe(token);
	});

	it("finds nothing in a cancelled run, and refuses a token cut too short to be whole", () => {
		expect(findSetupToken("Paste code here if prompted >\x1b[?25h\r\n")).toBeUndefined();
		expect(findSetupToken("sk-ant-oat01-abc\r\n")).toBeUndefined();
	});
});

describe("signInWithClaudeSubscription", () => {
	const signIn = async (exit: { code: number; output?: string }) => {
		const host = {
			ui: { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
			showApiKeyLoginDialog: vi.fn(async () => {}),
			showError: vi.fn(),
		};
		const back = vi.fn();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await signInWithClaudeSubscription(host as never, "/bin/claude", "Anthropic", back, async () => exit);
		} finally {
			stdout.mockRestore();
		}
		return { host, back };
	};

	it("saves the token the recorded run printed, without asking for it", async () => {
		// As Claude Code's terminal UI prints it: colors, a cursor move for the indent, the token cut at the width.
		const output = `Your OAuth token:\r\n\r\n\x1b[1C\x1b[32m${token.slice(0, 60)}\r\n${token.slice(60)}\x1b[39m\r\n\r\nStore it\r\n`;
		const { host } = await signIn({ code: 0, output });
		expect(host.showApiKeyLoginDialog).toHaveBeenCalledWith("anthropic", "Anthropic", expect.any(Function), token);
		expect(host.ui.stop).toHaveBeenCalledOnce();
		expect(host.ui.start).toHaveBeenCalledOnce();
	});

	it("asks for the token when the run was not recorded or the token cannot be read", async () => {
		for (const exit of [{ code: 0 }, { code: 0, output: "Paste code here if prompted >\r\n" }]) {
			const { host } = await signIn(exit);
			expect(host.showApiKeyLoginDialog).toHaveBeenCalledWith("anthropic", "Anthropic", expect.any(Function));
		}
	});

	it("saves nothing when the run fails, even if it printed a token", async () => {
		const { host, back } = await signIn({ code: 1, output: token });
		expect(host.showApiKeyLoginDialog).not.toHaveBeenCalled();
		expect(host.showError).toHaveBeenCalledWith("claude setup-token exited with code 1; nothing was saved.");
		expect(back).toHaveBeenCalledOnce();
	});
});

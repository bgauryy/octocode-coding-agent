import { resetMultiplexerCache } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeTmux, installFakeTmux } from "../../../tui/test/helpers/fake-tmux.ts";
import { checkTmuxKeyboardSetup } from "../../src/modes/interactive/interactive-mode/startup-checks.ts";

let fake: FakeTmux | undefined;
let savedTmux: string | undefined;

beforeEach(() => {
	savedTmux = process.env.TMUX;
	process.env.TMUX = "/tmp/tmux-1/default,1,0";
	resetMultiplexerCache();
});
afterEach(() => {
	fake?.restore();
	fake = undefined;
	if (savedTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = savedTmux;
});

describe("tmux extended-keys startup warning", () => {
	it("warns, naming the setting, when extended-keys is off", async () => {
		fake = installFakeTmux({ extendedKeys: "off" });
		const warning = await checkTmuxKeyboardSetup();
		expect(warning).toContain("tmux extended-keys is off");
		expect(warning).toContain("set -g extended-keys on");
		expect(fake.calls()).toEqual(["show -gv extended-keys"]);
	});

	it.each(["on", "always"])("stays quiet when extended-keys is %s", async (value) => {
		fake = installFakeTmux({ extendedKeys: value });
		expect(await checkTmuxKeyboardSetup()).toBeUndefined();
	});

	it("stays quiet when tmux cannot answer", async () => {
		fake = installFakeTmux({ fail: ["extendedKeys"] });
		expect(await checkTmuxKeyboardSetup()).toBeUndefined();
	});

	it("does not ask tmux outside a tmux session", async () => {
		delete process.env.TMUX;
		fake = installFakeTmux({ extendedKeys: "off" });
		expect(await checkTmuxKeyboardSetup()).toBeUndefined();
		expect(fake.calls()).toEqual([]);
	});
});

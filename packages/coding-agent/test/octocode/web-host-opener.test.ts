import { expect, it, vi } from "vitest";
import { openOnHost, planOpen } from "../../src/octocode/shared/host-opener.ts";

const DISPLAY = { DISPLAY: ":0" };

it.each([
	["vscode", { TERM_PROGRAM: "vscode", ...DISPLAY }, "vscode"],
	["cursor", { TERM_PROGRAM: "cursor", ...DISPLAY }, "cursor"],
	["iTerm", { TERM_PROGRAM: "iTerm.app", ...DISPLAY }, "iterm"],
	["Apple Terminal", { TERM_PROGRAM: "Apple_Terminal", ...DISPLAY }, "apple-terminal"],
	["tmux", { TMUX: "/tmp/tmux-1/default,1,0", ...DISPLAY }, "tmux"],
	["a plain terminal", { ...DISPLAY }, "terminal"],
])("opens a browser from %s", (_name, env, host) => {
	expect(planOpen(env, "linux")).toEqual({ host, action: "open" });
});

it("opens on macOS and Windows without a display variable", () => {
	expect(planOpen({ TERM_PROGRAM: "iTerm.app" }, "darwin").action).toBe("open");
	expect(planOpen({}, "win32").action).toBe("open");
});

it("prints the address over SSH, naming VS Code or Cursor when they run the terminal", () => {
	expect(planOpen({ SSH_CONNECTION: "1 2 3 4", ...DISPLAY }, "linux")).toMatchObject({ host: "ssh", action: "print" });
	expect(planOpen({ SSH_TTY: "/dev/pts/1", TERM_PROGRAM: "vscode" }, "darwin")).toMatchObject({
		host: "vscode",
		action: "print",
	});
	expect(planOpen({ SSH_CLIENT: "1 2 3", TERM_PROGRAM: "cursor" }, "linux").host).toBe("cursor");
});

it("prints the address when Linux has no display", () => {
	expect(planOpen({}, "linux")).toMatchObject({ host: "headless", action: "print" });
	expect(planOpen({ WAYLAND_DISPLAY: "wayland-0" }, "linux").action).toBe("open");
});

it("calls the opener when the plan opens and gives the address when it prints", async () => {
	const open = vi.fn(async () => undefined);
	expect(await openOnHost("http://x/", open, { host: "terminal", action: "open" })).toBeUndefined();
	expect(open).toHaveBeenCalledWith("http://x/");
	const notice = await openOnHost("http://x/", open, { host: "ssh", action: "print", reason: "Over SSH." });
	expect(notice).toBe("Over SSH. Open this link: http://x/");
	expect(open).toHaveBeenCalledOnce();
});

it("passes on the opener's own notice", async () => {
	const open = async () => "Opened in the default browser.";
	expect(await openOnHost("http://x/", open, { host: "terminal", action: "open" })).toBe(
		"Opened in the default browser.",
	);
});

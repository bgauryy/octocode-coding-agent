import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openTarget, openTargetCommand } from "../src/open-target.ts";

/** The real `spawn`, replaced: a test that reaches it would open an application on the machine running the suite. */
const systemSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (actual) => ({ ...(await actual<typeof ChildProcess>()), spawn: systemSpawn }));

/** A spawn that records its call and emits `outcome` on the child it returns. */
function fakeSpawn(outcome: "spawn" | Error) {
	const unref = vi.fn();
	const spawn = vi.fn(() => {
		const child = Object.assign(new EventEmitter(), { unref });
		queueMicrotask(() => (outcome === "spawn" ? child.emit("spawn") : child.emit("error", outcome)));
		return child;
	});
	return { spawn: spawn as never, calls: spawn.mock.calls as unknown as Array<[string, string[], object]>, unref };
}

describe("openTargetCommand on Windows", () => {
	const hostile = "C:\\Users\\me\\my repo\\a&b %PATH% ^x|y.html";

	it("calls the URL handler through rundll32 by its absolute System32 path, with the target as one argument", () => {
		expect(openTargetCommand(hostile, "win32", { SystemRoot: "D:\\Win\\" })).toEqual({
			command: "D:\\Win\\System32\\rundll32.exe",
			args: ["url.dll,FileProtocolHandler", hostile],
		});
		expect(openTargetCommand("https://example.com/?a=1&b=2", "win32", { windir: "C:\\Windows" }).args).toEqual([
			"url.dll,FileProtocolHandler",
			"https://example.com/?a=1&b=2",
		]);
	});

	it("never uses cmd, and skips a system root without a drive letter", () => {
		const { command } = openTargetCommand(hostile, "win32", { SystemRoot: "Windows", WINDIR: "relative\\dir" });
		expect(command).toBe("C:\\Windows\\System32\\rundll32.exe");
		expect(command.toLowerCase()).not.toContain("cmd");
	});
});

describe("openTargetCommand elsewhere", () => {
	it("uses open on macOS and xdg-open on other systems, with the target as one argument", () => {
		expect(openTargetCommand("/tmp/a b.html", "darwin")).toEqual({ command: "open", args: ["/tmp/a b.html"] });
		expect(openTargetCommand("/tmp/a b.html", "linux")).toEqual({ command: "xdg-open", args: ["/tmp/a b.html"] });
	});
});

describe("openTarget", () => {
	it("starts the opener detached without a shell and resolves once it started", async () => {
		const fake = fakeSpawn("spawn");
		await openTarget("https://example.com", {
			platform: "win32",
			env: { SystemRoot: "C:\\Windows" },
			spawn: fake.spawn,
		});
		const [command, args, options] = fake.calls[0];
		expect(command).toBe("C:\\Windows\\System32\\rundll32.exe");
		expect(args).toEqual(["url.dll,FileProtocolHandler", "https://example.com"]);
		expect(options).toEqual({ detached: true, stdio: "ignore", windowsHide: true });
		expect(options).not.toHaveProperty("shell");
		expect(options).not.toHaveProperty("windowsVerbatimArguments");
		expect(fake.unref).toHaveBeenCalledOnce();
	});

	it("rejects with the spawn error, such as a missing xdg-open", async () => {
		const fake = fakeSpawn(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
		await expect(openTarget("/tmp/x.html", { platform: "linux", spawn: fake.spawn })).rejects.toThrow("ENOENT");
	});

	it("starts nothing with OCTOCODE_OPEN_BROWSER=0 and rejects saying so", async () => {
		await expect(
			openTarget("https://example.com", { platform: "darwin", env: { OCTOCODE_OPEN_BROWSER: "0" } }),
		).rejects.toThrow("OCTOCODE_OPEN_BROWSER=0");
		expect(systemSpawn).not.toHaveBeenCalled();
	});
});

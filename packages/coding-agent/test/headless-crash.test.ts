import { afterEach, describe, expect, it } from "vitest";
import {
	crashLine,
	installHeadlessCrashHandlers,
	TERMINAL_RESET,
	type HeadlessCrashPorts,
} from "../src/modes/headless-crash.ts";

function ports(isTty: boolean) {
	const calls: string[] = [];
	let finish: (code: number) => void = () => {};
	const exit = new Promise<number>((resolve) => {
		finish = resolve;
	});
	const port: HeadlessCrashPorts = {
		isTty,
		writeTerminal: (text) => calls.push(`terminal:${text}`),
		writeError: (line) => calls.push(`error:${line}`),
		flush: async () => {
			calls.push("flush");
		},
		exit: (code) => {
			calls.push(`exit:${code}`);
			finish(code);
		},
	};
	return { calls, exit, port };
}
const emitter: NodeJS.EventEmitter = process;
let remove: (() => void) | undefined;
afterEach(() => remove?.());

describe("headless crash handlers", () => {
	it("prints one redacted line, flushes and exits 1 on an uncaught exception", async () => {
		const { calls, exit, port } = ports(false);
		remove = installHeadlessCrashHandlers(port);
		emitter.emit(
			"uncaughtException",
			new Error("boom sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nat stack"),
			"uncaughtException",
		);
		expect(await exit).toBe(1);
		const errors = calls.filter((call) => call.startsWith("error:"));
		expect(errors).toHaveLength(1);
		expect(errors[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(errors[0]).not.toContain("at stack");
		expect(calls.some((call) => call.startsWith("terminal:"))).toBe(false);
		expect(calls.indexOf("flush")).toBeLessThan(calls.indexOf("exit:1"));
	});

	it("restores terminal modes first when stdout is a terminal, once for repeated crashes", async () => {
		const { calls, exit, port } = ports(true);
		remove = installHeadlessCrashHandlers(port);
		emitter.emit("unhandledRejection", "nope", Promise.resolve());
		emitter.emit("unhandledRejection", "again", Promise.resolve());
		await exit;
		expect(calls[0]).toBe(`terminal:${TERMINAL_RESET}`);
		expect(calls.filter((call) => call.startsWith("error:"))).toEqual([
			"error:Octocode stopped on an unexpected error (unhandledRejection): nope\n",
		]);
		expect(calls.filter((call) => call.startsWith("exit:"))).toHaveLength(1);
	});

	it("describes a non-error value and an empty message", () => {
		expect(crashLine("x", "")).toContain("no message");
		expect(crashLine("x", 42)).toContain("42");
	});
});

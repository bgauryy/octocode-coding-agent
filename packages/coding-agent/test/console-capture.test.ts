import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessTerminal } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsoleToLog } from "../src/main/console-capture.ts";

describe("console capture while the terminal UI owns the screen", () => {
	let dir: string;
	let file: string;
	let writes: string[];
	let restoreConsole: (() => void) | undefined;
	const terminal = new ProcessTerminal();

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "octocode-console-"));
		file = path.join(dir, "console.log");
		writes = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		terminal.stop();
		restoreConsole?.();
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps console output out of the frame, logs it, and prints again once the terminal stops", () => {
		const real = vi.spyOn(console, "log").mockImplementation(() => {});
		restoreConsole = captureConsoleToLog(file);
		terminal.start(
			() => {},
			() => {},
		);
		writes.length = 0;
		console.log("stray line", { a: 1 });
		console.error("stray error");
		expect(writes.join("")).not.toContain("stray");
		const logged = readFileSync(file, "utf8");
		expect(logged).toContain("log stray line { a: 1 }");
		expect(logged).toContain("error stray error");

		terminal.stop();
		console.log("after stop");
		expect(real).toHaveBeenCalledWith("after stop");
		expect(readFileSync(file, "utf8")).not.toContain("after stop");
	});

	it("puts the real console methods back", () => {
		const realLog = console.log;
		restoreConsole = captureConsoleToLog(file);
		expect(console.log).not.toBe(realLog);
		restoreConsole();
		restoreConsole = undefined;
		expect(console.log).toBe(realLog);
	});
});

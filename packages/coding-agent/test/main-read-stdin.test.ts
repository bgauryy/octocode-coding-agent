import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { readPipedStdin } from "../src/main/startup.ts";

const read = (stdin: PassThrough, noticeMs: number) =>
	readPipedStdin(stdin as unknown as typeof process.stdin, noticeMs);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("readPipedStdin", () => {
	it("says once what it waits for when a pipe stays open and silent, and keeps waiting", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const stdin = new PassThrough();
		let settled = false;
		const reading = read(stdin, 10).then((text) => {
			settled = true;
			return text;
		});
		await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
		expect(error.mock.calls[0]?.[0]).toContain("--no-stdin");
		await sleep(40);
		expect(error).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		stdin.end("the prompt");
		await expect(reading).resolves.toBe("the prompt");
	});

	it("says nothing when the pipe closes in time or data keeps arriving", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const stdin = new PassThrough();
		const reading = read(stdin, 200);
		stdin.write("some ");
		await sleep(20);
		stdin.end("text");
		await expect(reading).resolves.toBe("some text");
		await sleep(250);
		expect(error).not.toHaveBeenCalled();
	});
});

describe("headless flags", () => {
	it("parses --no-stdin and --no-dialogs", () => {
		const parsed = parseArgs(["--no-stdin", "--no-dialogs", "hello"]);
		expect(parsed).toMatchObject({ noStdin: true, noDialogs: true, messages: ["hello"] });
		expect(parsed.unknownFlags.size).toBe(0);
	});
});

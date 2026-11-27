import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isMacosNamedPipe, pipeReader } from "../src/modes/rpc/rpc-input.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fifo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-input-"));
	dirs.push(dir);
	const file = path.join(dir, "commands.fifo");
	execFileSync("mkfifo", [file]);
	return file;
}

/** Everything the reader yields until its end. */
async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	let text = "";
	for await (const chunk of stream) text += String(chunk);
	return text;
}

describe.skipIf(process.platform === "win32")("RPC input on a named pipe", () => {
	it("reads a non-blocking end until its writer closes", async () => {
		const file = fifo();
		const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const writer = fs.openSync(file, "w");
		const stream = pipeReader(reader, 5);
		const text = readAll(stream);
		fs.writeSync(writer, "one\n");
		await new Promise((resolve) => setTimeout(resolve, 30));
		fs.writeSync(writer, "two\n");
		fs.closeSync(writer);
		expect(await text).toBe("one\ntwo\n");
		fs.closeSync(reader);
	});

	it("reads a blocking end until its writer closes", async () => {
		const file = fifo();
		const opening = fs.promises.open(file, "w");
		const reader = fs.openSync(file, "r");
		const writer = await opening;
		const text = readAll(pipeReader(reader));
		await writer.write("only\n");
		await writer.close();
		expect(await text).toBe("only\n");
		fs.closeSync(reader);
	});

	it("stops polling when destroyed", async () => {
		const file = fifo();
		const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const writer = fs.openSync(file, "w");
		const stream = pipeReader(reader, 5);
		stream.resume();
		await new Promise((resolve) => setTimeout(resolve, 20));
		stream.destroy();
		await new Promise((resolve) => stream.once("close", resolve));
		// A read already on the thread pool at destroy answers EAGAIN at once; let it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		fs.writeSync(writer, "late\n");
		await new Promise((resolve) => setTimeout(resolve, 30));
		// The bytes stay in the pipe: nothing read them after the stop.
		const left = Buffer.alloc(16);
		expect(left.toString("utf8", 0, fs.readSync(reader, left))).toBe("late\n");
		fs.closeSync(writer);
		fs.closeSync(reader);
	});

	it("takes the direct reader only for a named pipe on macOS", () => {
		const file = fifo();
		const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const regular = fs.openSync(path.join(path.dirname(file), "plain.txt"), "w");
		try {
			expect(isMacosNamedPipe(reader, "darwin")).toBe(true);
			expect(isMacosNamedPipe(reader, "linux")).toBe(false);
			expect(isMacosNamedPipe(regular, "darwin")).toBe(false);
		} finally {
			fs.closeSync(reader);
			fs.closeSync(regular);
		}
	});
});

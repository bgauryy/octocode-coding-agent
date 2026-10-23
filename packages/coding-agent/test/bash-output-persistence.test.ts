import * as fs from "node:fs";
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	createWriteStream: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each(["success", "cancel", "failure"] as const)("waits for full output persistence on %s", async (mode) => {
	let release!: () => void, ending!: () => void;
	const ended = new Promise<void>((resolve) => (ending = resolve));
	let saved = "";
	const expected = "line\n".repeat(3000);
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			saved += chunk.toString();
			callback();
		},
		final(callback) {
			release = callback;
			ending();
		},
	});
	vi.mocked(fs.createWriteStream).mockReturnValue(stream as fs.WriteStream);
	const controller = new AbortController();
	const error = new Error("execution failed");
	let returned = false;
	const result = executeBashWithOperations(
		"fixture",
		process.cwd(),
		{
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(mode === "failure" ? "x".repeat(100_000) : expected));
				if (mode === "cancel") controller.abort();
				if (mode !== "success") throw error;
				return { exitCode: 0 };
			},
		},
		{ signal: controller.signal },
	)
		.then(
			(value) => ({ value }),
			(failure) => ({ failure }),
		)
		.finally(() => {
			returned = true;
		});
	try {
		await ended;
		await new Promise((resolve) => setImmediate(resolve));
		expect(returned).toBe(false);
		release();
		const outcome = await result;
		if (mode === "failure") expect(outcome).toEqual({ failure: error });
		else {
			expect(outcome).toMatchObject({
				value: {
					truncated: true,
					cancelled: mode === "cancel",
					fullOutputPath: expect.any(String),
				},
			});
			expect(saved).toBe(expected);
		}
	} finally {
		release?.();
		await result;
		stream.destroy();
	}
});

it.each(["success", "cancel", "failure"] as const)(
	"handles early output errors without losing the %s outcome",
	async (mode) => {
		const writeError = new Error("disk failed"),
			execError = new Error("execution failed");
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				callback(writeError);
			},
		});
		vi.mocked(fs.createWriteStream).mockReturnValue(stream as fs.WriteStream);
		const controller = new AbortController();
		const result = executeBashWithOperations(
			"fixture",
			process.cwd(),
			{
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("x".repeat(100_000)));
					await new Promise((resolve) => setImmediate(resolve));
					if (mode === "cancel") controller.abort();
					if (mode !== "success") throw execError;
					return { exitCode: 0 };
				},
			},
			{ signal: controller.signal },
		);
		await expect(result).rejects.toBe(mode === "failure" ? execError : writeError);
	},
);

it("keeps concurrent and repeated accumulator closes attached to the same completion", async () => {
	const { OutputAccumulator } = await import("../src/core/tools/output-accumulator.ts");
	let release!: () => void, ending!: () => void;
	const ended = new Promise<void>((resolve) => (ending = resolve));
	const stream = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
		final(callback) {
			release = callback;
			ending();
		},
	});
	vi.mocked(fs.createWriteStream).mockReturnValue(stream as fs.WriteStream);
	const output = new OutputAccumulator({ maxBytes: 10 });
	output.append(Buffer.from("x".repeat(20)));
	output.finish();
	let firstDone = false,
		secondDone = false;
	const first = output.closeTempFile().then(() => {
		firstDone = true;
	});
	await ended;
	const second = output.closeTempFile().then(() => {
		secondDone = true;
	});
	try {
		await new Promise((resolve) => setImmediate(resolve));
		expect(firstDone).toBe(false);
		expect(secondDone).toBe(false);
		release();
		await Promise.all([first, second]);
		await output.closeTempFile();
		expect(stream.closed).toBe(true);
	} finally {
		release();
		await Promise.all([first, second]);
		stream.destroy();
	}
});

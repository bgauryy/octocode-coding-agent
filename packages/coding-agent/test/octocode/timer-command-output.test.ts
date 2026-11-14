import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { commandSpec } from "../../src/octocode/timer/conditions/command.ts";
import { capped, type ConditionDeps } from "../../src/octocode/timer/conditions/types.ts";

const { exec } = vi.hoisted(() => ({ exec: vi.fn<BashOperations["exec"]>() }));
vi.mock("../../src/octocode/files/bash-run.ts", () => ({ foregroundOperations: () => ({ exec }) }));

beforeEach(() => {
	exec.mockReset();
});
const env = { cwd: process.cwd(), deps: { context: () => undefined } as ConditionDeps };

describe("bounded timer command output", () => {
	it.each([1, 7, 8191, 65536])("keeps the same UTF-8 tail across chunks of %i bytes", async (chunkSize) => {
		const bytes = Buffer.from("prefix".repeat(10_000) + "世界🍊".repeat(700) + "last");
		exec.mockImplementation(async (_command, _cwd, { onData }) => {
			for (let offset = 0; offset < bytes.length; offset += chunkSize)
				onData(bytes.subarray(offset, offset + chunkSize));
			return { exitCode: 0 };
		});
		const result = await commandSpec.check({ kind: "command", command: "true" }, env);
		expect(result).toEqual({ met: true, exit: 0, output: capped(bytes.toString("utf8")) });
	});

	it("retains short output and appends a failure within the same cap", async () => {
		exec.mockImplementation(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("short 🍊"));
			return { exitCode: 0 };
		});
		expect((await commandSpec.check({ kind: "command", command: "true" }, env)).output).toBe("short 🍊");
		exec.mockImplementation(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("x".repeat(20_000)));
			throw new Error("timed out");
		});
		const result = await commandSpec.check({ kind: "command", command: "true" }, env);
		expect(result.output).toBe(capped("x".repeat(20_000) + "\ntimed out"));
		expect(result.met).toBe(false);
	});
});

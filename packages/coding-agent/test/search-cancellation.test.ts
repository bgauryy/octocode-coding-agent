import { spawn } from "child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import * as pathUtils from "../src/core/tools/path-utils.ts";

vi.mock("child_process", () => ({
	spawn: vi.fn(() => {
		throw new Error("Unexpected process launch");
	}),
}));
vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: vi.fn(async (tool: string) => tool) }));
vi.mock("../src/core/tools/path-utils.ts", async (importOriginal) => ({
	...(await importOriginal<typeof pathUtils>()),
	pathExists: vi.fn(),
}));

describe("search cancellation before process launch", () => {
	beforeEach(() => vi.clearAllMocks());
	it("does not launch grep after cancellation during directory lookup", async () => {
		const controller = new AbortController();
		const tool = createGrepTool("/tmp", {
			operations: {
				isDirectory: async () => {
					controller.abort();
					return true;
				},
				readFile: () => "",
			},
		});
		await expect(tool.execute("grep", { pattern: "x" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(spawn).not.toHaveBeenCalled();
	});
	it("does not launch find after cancellation during repository lookup", async () => {
		const controller = new AbortController();
		vi.mocked(pathUtils.pathExists).mockImplementation(async () => {
			controller.abort();
			return true;
		});
		await expect(createFindTool("/tmp").execute("find", { pattern: "*" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(spawn).not.toHaveBeenCalled();
	});
});

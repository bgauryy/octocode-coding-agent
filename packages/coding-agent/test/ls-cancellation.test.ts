import { describe, expect, it, vi } from "vitest";
import { createLsTool } from "../src/core/tools/ls.ts";

describe("ls cancellation", () => {
	it("stops before stat when cancelled during path lookup", async () => {
		const controller = new AbortController();
		let completeLookup!: (exists: boolean) => void;
		const lookup = new Promise<boolean>((resolve) => {
			completeLookup = resolve;
		});
		const stat = vi.fn(() => ({ isDirectory: () => true }));
		const tool = createLsTool("/tmp", { operations: { exists: () => lookup, stat, readdir: () => [] } });
		const result = tool.execute("ls", {}, controller.signal);
		const rejected = expect(result).rejects.toThrow("Operation aborted");
		controller.abort();
		await rejected;
		completeLookup(true);
		await new Promise((resolve) => setImmediate(resolve));
		expect(stat).not.toHaveBeenCalled();
	});

	it.each(["missing", "file", "unreadable"])("removes the abort listener for a %s path", async (failure) => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const tool = createLsTool("/tmp", {
			operations: {
				exists: () => failure !== "missing",
				stat: () => ({ isDirectory: () => failure !== "file" }),
				readdir: () => {
					throw new Error("denied");
				},
			},
		});
		await expect(tool.execute("ls", {}, controller.signal)).rejects.toThrow();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});
});

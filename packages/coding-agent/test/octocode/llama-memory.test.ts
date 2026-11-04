import { describe, expect, it } from "vitest";
import { memoryWarning } from "../../src/octocode/llama/memory.ts";

const GIB = 1024 ** 3;

describe("a local model against this machine's memory", () => {
	it("says nothing when it fits, or when its size is unknown", () => {
		expect(memoryWarning(4 * GIB, 8 * GIB, 16 * GIB)).toBeUndefined();
		expect(memoryWarning(undefined, GIB, 16 * GIB)).toBeUndefined();
	});

	it("warns when it is larger than free memory, naming both", () => {
		const warning = memoryWarning(9 * GIB, 4 * GIB, 16 * GIB);
		expect(warning).toContain("9");
		expect(warning).toContain("4");
		expect(warning).toContain("may freeze the machine");
		expect(warning).toContain("close other programs");
	});

	it("does not suggest closing programs for a model larger than the machine", () => {
		const warning = memoryWarning(40 * GIB, 8 * GIB, 16 * GIB);
		expect(warning).toContain("more than this machine's");
		expect(warning).not.toContain("close other programs");
	});
});

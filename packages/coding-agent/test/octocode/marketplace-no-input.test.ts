import { afterEach, describe, expect, it, vi } from "vitest";
import { NoInputError } from "../../src/cli/no-input.ts";
import { askOnTerminal } from "../../src/octocode/plugins/marketplace/command.ts";

afterEach(() => vi.unstubAllEnvs());

describe("marketplace approval prompt", () => {
	it("fails fast under OCTOCODE_NO_INPUT instead of reading stdin", async () => {
		vi.stubEnv("OCTOCODE_NO_INPUT", "1");
		await expect(askOnTerminal("Approve?")).rejects.toBeInstanceOf(NoInputError);
	});
});

import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { buildSessionOptions } from "../src/main/session-options.ts";

const runtime = { getAvailable: () => [], find: () => undefined } as never;
const settings = { getDefaultProvider: () => undefined, getDefaultModel: () => undefined } as never;
const errors = (parsed: Partial<Args>) =>
	buildSessionOptions(parsed as Args, [], false, runtime, settings)
		.diagnostics.filter((diagnostic) => diagnostic.type === "error")
		.map((diagnostic) => diagnostic.message);

describe("--provider without --model", () => {
	it("is an error when it would choose the session's model", () => {
		expect(errors({ provider: "anthropic", messages: [], fileArgs: [] })).toEqual([
			expect.stringContaining("--provider requires --model"),
		]);
	});

	it("filters --list-models, as providers.md shows, without an error", () => {
		expect(errors({ provider: "anthropic", listModels: "claude", messages: [], fileArgs: [] })).toEqual([]);
		expect(errors({ provider: "anthropic", listModels: true, messages: [], fileArgs: [] })).toEqual([]);
	});
});

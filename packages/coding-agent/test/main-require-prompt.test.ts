import { afterEach, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { requirePrompt } from "../src/main/startup.ts";

const args = (messages: string[] = []): Args => ({ messages, fileArgs: [], unknownFlags: [], diagnostics: [] });

afterEach(() => vi.restoreAllMocks());

it("exits 2 with a next step when a print or json run has no prompt", () => {
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	requirePrompt("print", undefined, args());
	expect(exit).toHaveBeenCalledWith(2);
	expect(String(error.mock.calls[0][0])).toContain("no prompt given");
	requirePrompt("json", "  ", args());
	expect(exit).toHaveBeenCalledTimes(2);
});

it("lets runs with a prompt, and interactive or rpc runs, through", () => {
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	requirePrompt("print", "fix it", args());
	requirePrompt("json", undefined, args(["later"]));
	requirePrompt("interactive", undefined, args());
	requirePrompt("rpc", undefined, args());
	expect(exit).not.toHaveBeenCalled();
});

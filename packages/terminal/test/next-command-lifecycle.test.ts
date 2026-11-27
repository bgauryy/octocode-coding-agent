import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { type NextCommandRequest, NextCommandSuggester } from "../src/next-command.ts";

const request = (prefix = "git"): NextCommandRequest => ({
	prefix,
	cwd: "/repo",
	shell: "zsh",
	platform: "darwin",
	recent: [],
	reply: [],
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("command suggestion lifecycle", () => {
	it("does not start a model call for an already aborted request", async () => {
		let calls = 0;
		const suggestions = new NextCommandSuggester(async () => {
			calls++;
			return "git status";
		});
		expect(await suggestions.suggest(request(), AbortSignal.abort())).toBeUndefined();
		expect(calls).toBe(0);
	});

	it("releases cancellation even when the model ignores its signal", async () => {
		let finish!: (reply: string | undefined) => void;
		const stalled = new Promise<string | undefined>((resolve) => {
			finish = resolve;
		});
		let calls = 0;
		const suggestions = new NextCommandSuggester(async () => (++calls === 1 ? stalled : "git diff"));
		const abort = new AbortController();
		let settled = false;
		const first = suggestions.suggest(request(), abort.signal).then(() => {
			settled = true;
		});
		try {
			await settle();
			abort.abort();
			await settle();
			expect(settled).toBe(true);
			expect(await suggestions.suggest(request(), new AbortController().signal)).toBe("git diff");
		} finally {
			finish("git status");
			await first;
		}
		expect(suggestions.cached("/repo", "git")).toBe("git diff");
	});

	it("forgets in-flight work without letting its result overwrite a new request", async () => {
		const finishes: Array<(reply: string | undefined) => void> = [];
		const suggestions = new NextCommandSuggester(
			() =>
				new Promise((resolve) => {
					finishes.push(resolve);
				}),
		);
		const first = suggestions.suggest(request(), new AbortController().signal);
		await settle();
		suggestions.forget();
		const second = suggestions.suggest(request(), new AbortController().signal);
		try {
			await settle();
			expect(finishes.length).toBe(2);
			finishes[0]("git stale");
			await first;
			expect(suggestions.cached("/repo", "git")).toBeUndefined();
			const shared = suggestions.suggest(request(), new AbortController().signal);
			await settle();
			expect(finishes.length).toBe(2);
			finishes[1]("git diff");
			expect(await second).toBe("git diff");
			expect(await shared).toBe("git diff");
		} finally {
			for (const finish of finishes) finish(undefined);
			await Promise.all([first, second]);
		}
	});

	it("releases caller abort listeners when results finish", async () => {
		const suggestions = new NextCommandSuggester(async () => "git status");
		const abort = new AbortController();
		expect(await suggestions.suggest(request(), abort.signal)).toBe("git status");
		expect(getEventListeners(abort.signal, "abort")).toEqual([]);
	});

	it("evicts old cached prefixes while retaining recently used answers", async () => {
		const suggestions = new NextCommandSuggester(async (req) => `${req.prefix} status`);
		const signal = new AbortController().signal;
		for (let i = 0; i < 256; i++) await suggestions.suggest(request(`cmd${i}`), signal);
		expect(suggestions.cached("/repo", "cmd0")).toBe("cmd0 status");
		await suggestions.suggest(request("cmd256"), signal);
		expect(suggestions.cached("/repo", "cmd1")).toBeUndefined();
		expect(suggestions.cached("/repo", "cmd0")).toBe("cmd0 status");
		expect(suggestions.cached("/repo", "cmd256")).toBe("cmd256 status");
	});
});

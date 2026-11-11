import type { AutocompleteProvider } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextCommandSuggester, type ShellCompletionService } from "../../../terminal/src/index.ts";
import type { ExtensionContext } from "../../src/core/features/index.ts";
import { GhostController, type GhostSources } from "../../src/octocode/terminal/ghost.ts";
import { askSmallModel, suggestionPrompt } from "../../src/octocode/terminal/model.ts";
import { ShellAwareProvider, shellPrefix } from "../../src/octocode/terminal/provider.ts";

const small = vi.hoisted(() => vi.fn());
vi.mock("../../src/octocode/subagents/small-call.ts", () => ({ callSmallModel: small }));

afterEach(() => {
	vi.useRealTimers();
	small.mockReset();
});

const base: AutocompleteProvider = {
	getSuggestions: async () => ({ prefix: "base", items: [{ value: "from-base", label: "from-base" }] }),
	applyCompletion: (lines) => ({ lines: [...lines, "base-applied"], cursorLine: 0, cursorCol: 0 }),
};

function serviceWith(result: Awaited<ReturnType<ShellCompletionService["complete"]>>, seen: string[] = []) {
	return {
		complete: async (text: string) => {
			seen.push(text);
			return result;
		},
	} as unknown as ShellCompletionService;
}

const signal = () => new AbortController().signal;

describe("shellPrefix", () => {
	it("finds ! and !! with their spaces on the first line only", () => {
		expect(shellPrefix(["!git"], 0)).toBe("!");
		expect(shellPrefix(["  !! ls"], 0)).toBe("  !! ");
		expect(shellPrefix(["hello"], 0)).toBeUndefined();
		expect(shellPrefix(["!a", "b"], 1)).toBeUndefined();
	});
});

describe("ShellAwareProvider", () => {
	it("asks the shell only on Tab and only for ! lines", async () => {
		const seen: string[] = [];
		const provider = new ShellAwareProvider(base, () =>
			serviceWith(
				{ start: 4, source: "zsh", items: [{ value: "checkout", label: "checkout", description: "switch" }] },
				seen,
			),
		);
		const tab = await provider.getSuggestions(["!git che"], 0, 8, { signal: signal(), force: true });
		expect(seen).toEqual(["git che"]);
		expect(tab).toEqual({
			prefix: "che",
			items: [{ value: "checkout", label: "checkout", description: "switch", shellNoSpace: false }],
		});
		expect((await provider.getSuggestions(["!git che"], 0, 8, { signal: signal() }))?.prefix).toBe("base");
		expect((await provider.getSuggestions(["git che"], 0, 7, { signal: signal(), force: true }))?.prefix).toBe("base");
	});

	it("falls back to the built-in provider when the shell has nothing", async () => {
		const provider = new ShellAwareProvider(base, () => serviceWith(undefined));
		expect((await provider.getSuggestions(["!ls sr"], 0, 6, { signal: signal(), force: true }))?.prefix).toBe("base");
	});

	it("inserts a shell item with a space unless it opens a folder or one follows", () => {
		const provider = new ShellAwareProvider(base, () => undefined);
		const word = { value: "checkout", label: "checkout", shellNoSpace: false };
		expect(provider.applyCompletion(["!git che"], 0, 8, word, "che")).toEqual({
			lines: ["!git checkout "],
			cursorLine: 0,
			cursorCol: 14,
		});
		const dir = { value: "src/", label: "src/", shellNoSpace: true };
		expect(provider.applyCompletion(["!ls sr -la"], 0, 6, dir, "sr").lines).toEqual(["!ls src/ -la"]);
		expect(provider.applyCompletion(["!ls"], 0, 3, { value: "x", label: "x" }, "").lines).toEqual([
			"!ls",
			"base-applied",
		]);
	});

	it("triggers on Tab for any ! line", () => {
		const provider = new ShellAwareProvider({ ...base, shouldTriggerFileCompletion: () => false }, () => undefined);
		expect(provider.shouldTriggerFileCompletion(["!"], 0, 1)).toBe(true);
		expect(provider.shouldTriggerFileCompletion(["hi"], 0, 2)).toBe(false);
	});
});

function ghostWith(overrides: Partial<GhostSources> = {}) {
	const shown: Array<string | undefined> = [];
	const asked: string[] = [];
	const suggester = new NextCommandSuggester(async (request) => {
		asked.push(request.prefix);
		return request.prefix === "dock" ? "docker compose up" : "NONE";
	});
	const ghost = new GhostController({
		setSuggestion: (text) => shown.push(text),
		cwd: () => "/repo",
		history: () => [{ command: "npm run build", cwd: "/repo", count: 3, lastAt: Date.now() }],
		reply: () => ["npm test"],
		historyEnabled: () => true,
		modelEnabled: () => true,
		suggester,
		request: (prefix) => ({ prefix, cwd: "/repo", shell: "zsh", platform: "darwin", recent: [], reply: [] }),
		delayMs: 10,
		...overrides,
	});
	return { ghost, shown, asked };
}

describe("GhostController", () => {
	it("suggests from the last reply, then history, keeping the bang", () => {
		const { ghost, shown } = ghostWith();
		ghost.update("!npm t");
		ghost.update("!! npm r");
		ghost.update("not shell");
		expect(shown).toEqual(["!npm test", "!! npm run build", undefined]);
	});

	it("asks the model after a pause, once per prefix", async () => {
		const { ghost, shown, asked } = ghostWith();
		ghost.update("!dock");
		await vi.waitFor(() => expect(shown.at(-1)).toBe("!docker compose up"));
		ghost.update("!docke");
		expect(shown.at(-1)).toBe("!docker compose up");
		ghost.update("!dock");
		ghost.update("!zz");
		await vi.waitFor(() => expect(asked).toEqual(["dock", "zz"]));
		ghost.update("!zz");
		expect(asked).toEqual(["dock", "zz"]);
	});

	it("never asks when the model is off and drops a late answer", async () => {
		const off = ghostWith({ modelEnabled: () => false });
		off.ghost.update("!dock");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(off.asked).toEqual([]);
		const late = ghostWith();
		late.ghost.update("!dock");
		late.ghost.update("!x");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(late.shown.includes("!docker compose up")).toBe(false);
	});
});

describe("the model suggestion", () => {
	const request = {
		prefix: "git s",
		cwd: "/repo",
		shell: "zsh",
		platform: "darwin" as const,
		recent: [{ command: "git add .", exitCode: 0 }],
		reply: ["git status"],
	};

	it("renders the prompt with the typed text, recent commands and reply commands", () => {
		const prompt = suggestionPrompt(request);
		expect(prompt).toContain("<typed>git s</typed>");
		expect(prompt).toContain("git add .  # exit 0");
		expect(prompt).toContain("git status");
		expect(prompt).toContain("zsh on darwin");
		expect(prompt).toContain("reply NONE");
	});

	it("records the small model's usage and returns its text", async () => {
		const usage = { input: 1, output: 2 };
		small.mockResolvedValue({ text: "git status", model: "p/m", provider: "p", modelId: "m", usage });
		const recordUsage = vi.fn();
		const text = await askSmallModel({ recordUsage }, {} as ExtensionContext, request, signal());
		expect(text).toBe("git status");
		expect(recordUsage).toHaveBeenCalledWith("shell_suggestion", "p", "m", usage);
		expect(small.mock.calls[0][1]).toMatchObject({ maxTokens: 128 });
		expect(small.mock.calls[0][1].fallbackToSession).toBeUndefined();
	});

	it("gives nothing when no cheaper model is available", async () => {
		small.mockResolvedValue({ error: "no cheaper model is available" });
		const recordUsage = vi.fn();
		expect(await askSmallModel({ recordUsage }, {} as ExtensionContext, request, signal())).toBeUndefined();
		expect(recordUsage).not.toHaveBeenCalled();
	});
});

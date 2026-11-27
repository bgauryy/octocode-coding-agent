import { describe, expect, it } from "vitest";
import { parseCarapaceExport } from "../src/carapace.ts";
import { commandFromReply, NextCommandSuggester, type NextCommandRequest } from "../src/next-command.ts";
import { type HistoryEntry, rankHistory, replyCommands, suggestCommand } from "../src/suggest.ts";

const NOW = Date.UTC(2026, 10, 10);
const entry = (command: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
	command,
	cwd: "/repo",
	count: 1,
	lastAt: NOW,
	...extra,
});

describe("rankHistory", () => {
	it("prefers this folder, frequent and successful commands", () => {
		const history = [
			entry("npm run build", { cwd: "/other", count: 5 }),
			entry("npm run test", { count: 2 }),
			entry("npm run tset", { count: 9, lastExit: 127 }),
		];
		expect(rankHistory(history, "npm run t", "/repo", NOW)).toBe("npm run test");
		expect(rankHistory(history, "npm run b", "/repo", NOW)).toBe("npm run build");
	});

	it("needs a prefix it extends", () => {
		expect(rankHistory([entry("ls")], "", "/repo", NOW)).toBeUndefined();
		expect(rankHistory([entry("ls")], "ls", "/repo", NOW)).toBeUndefined();
	});

	it("lets old runs fade", () => {
		const history = [entry("git push", { count: 3, lastAt: NOW - 60 * 86_400_000 }), entry("git pull")];
		expect(rankHistory(history, "git p", "/repo", NOW)).toBe("git pull");
	});
});

describe("replyCommands", () => {
	it("reads one-line commands from shell blocks", () => {
		const reply = [
			"Run:",
			"```bash",
			"# build first",
			"npm run build",
			"$ npm test",
			"docker run \\",
			"  -it image",
			"```",
			"```ts",
			"const x = 1;",
			"```",
			"```console",
			"$ git status",
			"On branch main",
			"```",
		].join("\n");
		expect(replyCommands(reply)).toEqual(["npm run build", "npm test", "git status"]);
	});
});

describe("suggestCommand", () => {
	it("uses the reply first, then history", () => {
		const options = { cwd: "/repo", history: [entry("npm install")], reply: ["npm run lint"], now: NOW };
		expect(suggestCommand("npm r", options)).toBe("npm run lint");
		expect(suggestCommand("npm i", options)).toBe("npm install");
		expect(suggestCommand("", options)).toBe("npm run lint");
		expect(suggestCommand("", { ...options, reply: [] })).toBeUndefined();
	});
});

describe("commandFromReply", () => {
	it("keeps one command that extends the prefix", () => {
		expect(commandFromReply("git status", "git s")).toBe("git status");
		expect(commandFromReply("```bash\ngit status\n```", "")).toBe("git status");
		expect(commandFromReply("`ls -la`", "ls")).toBe("ls -la");
		expect(commandFromReply("$ make", "")).toBe("make");
		expect(commandFromReply("NONE", "")).toBeUndefined();
		expect(commandFromReply("rm -rf /", "git")).toBeUndefined();
		expect(commandFromReply("a\nb", "")).toBeUndefined();
		expect(commandFromReply("git", "git")).toBeUndefined();
	});
});

describe("NextCommandSuggester", () => {
	const request = (prefix: string): NextCommandRequest => ({
		prefix,
		cwd: "/repo",
		shell: "zsh",
		platform: "darwin",
		recent: [],
		reply: [],
	});

	it("asks once per prefix and caches misses", async () => {
		const asked: string[] = [];
		const suggester = new NextCommandSuggester(async (req) => {
			asked.push(req.prefix);
			return req.prefix === "git" ? "git status" : "NONE";
		});
		const signal = new AbortController().signal;
		expect(await suggester.suggest(request("git"), signal)).toBe("git status");
		expect(await suggester.suggest(request("git"), signal)).toBe("git status");
		expect(await suggester.suggest(request("x"), signal)).toBeUndefined();
		expect(await suggester.suggest(request("x"), signal)).toBeUndefined();
		expect(asked).toEqual(["git", "x"]);
		expect(suggester.cached("/repo", "x")).toBeNull();
		suggester.forget();
		expect(suggester.cached("/repo", "git")).toBeUndefined();
	});

	it("does not cache an aborted call", async () => {
		const suggester = new NextCommandSuggester(
			(_req, signal) =>
				new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
		);
		const controller = new AbortController();
		const pending = suggester.suggest(request("g"), controller.signal);
		controller.abort();
		expect(await pending).toBeUndefined();
		expect(suggester.cached("/repo", "g")).toBeUndefined();
	});
});

describe("parseCarapaceExport", () => {
	it("reads values, descriptions and no-space suffixes", () => {
		const json = JSON.stringify({
			nospace: "/",
			values: [
				{ value: "checkout", display: "checkout", description: "Switch branches" },
				{ value: "src/", display: "src/" },
				{ display: "no value" },
			],
		});
		expect(parseCarapaceExport(json)).toEqual([
			{ value: "checkout", description: "Switch branches", flags: "" },
			{ value: "src/", description: "", flags: "n" },
		]);
		expect(parseCarapaceExport("not json")).toEqual([]);
	});
});

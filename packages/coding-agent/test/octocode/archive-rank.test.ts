import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerArchiveTool } from "../../src/octocode/archive/tool.ts";
import { renderMessages } from "../../src/octocode/compaction/archive/render.ts";
import { writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import { archiveFolder, libraryPath, type Segment, writeSegment } from "../../src/octocode/history/archive.ts";
import { parseKeywords, stem, wordTerms } from "../../src/octocode/history/rank.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const why = { reason: "the user asked what was decided earlier" };

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
	setCurrentSession("me");
});
afterEach(() => {
	setCurrentSession(undefined);
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

function repo(prefix?: string): string {
	const cwd = tmp(prefix);
	fs.mkdirSync(path.join(cwd, ".git"));
	return cwd;
}

const segment = (session: string): Omit<Segment, "n"> => ({
	session,
	entry: `e-${session}`,
	tokensBefore: 1_000,
	method: "standalone",
	tldr: `work of ${session}`,
	topics: [],
	readFiles: [],
	modifiedFiles: [],
	messages: 1,
});

/** A segment of session `id` whose messages are `passages`, each under its own heading, after 30 filler messages. */
function history(id: string, cwd: string, passages: string[]): void {
	setCurrentSession(id);
	const filler = Array.from({ length: 30 }, (_, n) => `### user\nfiller message ${n} about nothing in particular`);
	writeSegment(segment(id), [...filler, ...passages.map((text) => `### assistant\n${text}`)].join("\n\n"));
	writeSessionRecord({
		session: id,
		repository: fs.realpathSync(cwd),
		workspace: cwd,
		goal: { role: "user", text: `goal of ${id}` },
		ending: [],
		toolCalls: 0,
	});
	setCurrentSession("me");
}

function tool(cwd: string) {
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const archive = fake.tools.get("archive");
	const ctx = fakeCtx({ cwd });
	return async (params: Record<string, unknown>) => {
		const out = await archive.execute("t1", params, undefined, undefined, ctx);
		// Op-less calls are session history (source sessions); its own details sit under `history`.
		return { text: out.content[0].text as string, details: out.details.history ?? out.details };
	};
}

/** The passage text of each ranked result, in rank order. */
const ranking = (text: string): string[] =>
	[...text.matchAll(/^## \d+\. score [\d.]+[^\n]*\n(?:[^\n]*\n)*?>\s*\d+│ ([^\n]*)/gm)].map((match) => match[1]);

describe("archive keywords (BM25)", () => {
	it("ranks the passage covering the rare terms above one repeating a common term, and names terms found nowhere", async () => {
		const cwd = repo();
		history("me", cwd, [
			"login login login: more chatter about the login page and login copy",
			"The loginRedirect fix moved the OAuth callback to /auth/done",
			"login styles changed",
		]);
		const call = tool(cwd);
		const found = await call({ ...why, keywords: "login redirect oauth kerberos" });
		expect(found.details).toMatchObject({ ...why, mode: "rank", hits: 3, files: 1, page: 1, pages: 1 });
		expect(ranking(found.text)[0]).toContain("loginRedirect fix");
		expect(found.text).toContain("Passages per term: login 3 · redirect 1 · oauth 1 · kerberos 0.");
		expect(found.text).toContain("In none: kerberos; try a synonym, another spelling or an identifier.");
		// A ranked hit names its file and lines, so it can be read with file and line.
		expect(found.text).toMatch(/score [\d.]+ · \S+1-e-me\.md · me \(this session\) · segment 1[^\n]* · lines \d+–\d+/);
	});

	it("matches inflections and the parts of identifiers and paths", async () => {
		const cwd = repo();
		history("me", cwd, ["the keychain tests failed in auth-storage/keychainLogin.ts", "unrelated words"]);
		const found = await tool(cwd)({ ...why, keywords: "failing test keychain login" });
		expect(found.details).toMatchObject({ hits: 1 });
		expect(ranking(found.text)[0]).toContain("keychain tests failed");
	});

	it("ranks a record by what the session said, not by the folders it ran in", async () => {
		// The record names its repository and workspace, here a temporary folder: their words are this machine's, not the session's.
		const cwd = repo("octocode-zeppelin-");
		history("me", cwd, ["unrelated words"]);
		const call = tool(cwd);
		const missed = await call({ ...why, keywords: "zeppelin" });
		expect(missed.details).toMatchObject({ mode: "rank", hits: 0 });
		// The rest of the record still ranks, and its shown lines never mark a path.
		const goal = await call({ ...why, keywords: "goal zeppelin" });
		expect(goal.text).toMatch(/· record: goal and ending · /);
		expect(goal.text).toMatch(/^>\s*\d+│ - Goal: goal of me$/m);
		expect(goal.text).not.toMatch(/^>.*│ - (?:Repository|Workspace): /m);
	});

	it("ranks a record by what the session said, not by the wording every record shares", async () => {
		const cwd = repo();
		writeSessionRecord({
			session: "me",
			repository: fs.realpathSync(cwd),
			workspace: cwd,
			name: "hangar plans",
			started: "2026-10-31T10:00:00Z",
			goal: { role: "user", at: "2026-10-31T10:00:00Z", text: "plan the zeppelin hangar" },
			ending: [
				{ role: "user", text: "is the hangar finished?" },
				{ role: "assistant", text: "yes, the roof is up" },
			],
			toolCalls: 3,
		});
		const call = tool(cwd);
		// The title, note, field labels and headings are in every record, so they match nothing.
		const template = await call({
			...why,
			keywords:
				"session record goal ending message user assistant code data instructions name started tool calls segments transcript",
		});
		expect(template.details).toMatchObject({ mode: "rank", hits: 0 });
		// Field values and messages still rank: the Session line, the Name and Goal values, the goal and the ending.
		await expect(call({ ...why, keywords: "me" })).resolves.toMatchObject({ details: { hits: 1 } });
		const own = await call({ ...why, keywords: "hangar" });
		expect(own.details).toMatchObject({ hits: 3 });
		expect(own.text).toMatch(/^>\s*\d+│ - Name: hangar plans$/m);
		expect(own.text).toMatch(/^>\s*\d+│ is the hangar finished\?$/m);
		// A regex query still matches any line.
		const regex = await call({ ...why, query: "the first user message" });
		expect(regex.details).toMatchObject({ mode: "search", hits: 1 });
	});

	it("ranks a segment and the library by what the session said, not by the wording each of them repeats", async () => {
		const cwd = repo();
		// The messages as compaction files them: headings, tool lines and fences around their text.
		const body = renderMessages(
			[
				{ role: "user", content: "plan the zeppelin hangar" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will check the roof" },
						{ type: "toolCall", name: "bash", id: "c7", arguments: { path: "hangar" } },
						{ type: "image" },
					],
				},
				{ role: "toolResult", toolName: "bash", toolCallId: "c7", isError: true, content: "hangar: not found" },
				{ role: "bashExecution", command: "df -h", exitCode: 1, output: "disk full" },
				{ role: "assistant", content: "", errorMessage: "rate limited" },
			],
			() => undefined,
		);
		writeSegment(
			{
				...segment("me"),
				tldr: "hangar planning",
				topics: ["zeppelins"],
				readFiles: ["docs/hangar.md"],
				modifiedFiles: ["src/hangar.ts"],
				messages: 5,
			},
			body,
		);
		const call = tool(cwd);
		// The title, note, field labels, message headings and the fixed words of tool, command, error and image lines.
		const template = await call({
			...why,
			keywords:
				"user assistant toolresult bashexecution tool call id error command exit image omitted archived history session segment compaction entry tokens summary method messages conversation context instructions verbatim thinking blocks files topics",
		});
		expect(template.details).toMatchObject({ mode: "rank", hits: 0 });
		// What the session said still ranks: the TL;DR and files, the messages, a tool's arguments and output, and its name.
		await expect(call({ ...why, keywords: "hangar" })).resolves.toMatchObject({ details: { hits: 4 } });
		await expect(call({ ...why, keywords: "bash" })).resolves.toMatchObject({ details: { hits: 2 } });
		await expect(call({ ...why, keywords: "disk limited" })).resolves.toMatchObject({ details: { hits: 2 } });
		// A regex query still matches any line.
		await expect(call({ ...why, query: "^Tool call " })).resolves.toMatchObject({
			details: { mode: "search", hits: 1 },
		});
		// The library counts its rows' TL;DR, topics and files, not its own wording.
		const library = libraryPath("me");
		const libraryTemplate = await call({
			...why,
			file: library,
			keywords:
				"archive library compacted history folder markdown messages summarized tool calls results detail summary data instructions search keywords ranked query regex line term spelling session goal ended time range utc tokens before topics files file branch leaf modified read more standalone",
		});
		expect(libraryTemplate.details).toMatchObject({ mode: "rank", hits: 0 });
		const row = await call({ ...why, file: library, keywords: "zeppelins hangar" });
		expect(row.details).toMatchObject({ hits: 1 });
		expect(row.text).toMatch(
			/^>\s*\d+│ \| 1 \| .*hangar planning \| zeppelins \| modified: src\/hangar\.ts; read 1 \|/m,
		);
	});

	it("boosts a quoted phrase, filters by query and narrows to one session", async () => {
		const cwd = repo();
		history("me", cwd, ["warm the cache before the request", "cache warm runs after B314 landed"]);
		history("sib", cwd, ["cache warm in the sibling session"]);
		const call = tool(cwd);
		const phrased = await call({ ...why, keywords: '"cache warm"', file: archiveFolder("me") });
		expect(phrased.details).toMatchObject({ hits: 2, files: 1 });
		expect(ranking(phrased.text)[0]).toContain("cache warm runs");
		const filtered = await call({ ...why, keywords: "cache warm", query: "B3\\d\\d" });
		expect(filtered.details).toMatchObject({ hits: 1 });
		const missed = await call({ ...why, keywords: "zeppelin" });
		expect(missed.details).toMatchObject({ mode: "rank", hits: 0, pages: 0 });
		expect(missed.text).toMatch(/No passage matches\. Try synonyms, other spellings/);
		await expect(call({ ...why, keywords: "   " })).resolves.toMatchObject({ details: { mode: "list" } });
	});

	it("runs the query filter off the main thread and stops a runaway expression, as a query search does", async () => {
		const cwd = repo();
		// `(a+)+$` backtracks exponentially on a run of a's that does not end the line: many seconds for 29 of them.
		history("me", cwd, [`cache ${"a".repeat(29)}!`]);
		let last = Date.now();
		let longestStall = 0;
		const ticker = setInterval(() => {
			longestStall = Math.max(longestStall, Date.now() - last);
			last = Date.now();
		}, 50);
		try {
			await expect(tool(cwd)({ ...why, keywords: "cache", query: "(a+)+$" })).rejects.toThrow(/exceeded 5 seconds/);
		} finally {
			clearInterval(ticker);
		}
		expect(longestStall).toBeLessThan(1_000);
	}, 30_000);
});

describe("keyword terms", () => {
	it("stems inflections to one root and splits identifiers into their parts", () => {
		expect(["fail", "fails", "failed", "failing"].map(stem)).toEqual(["fail", "fail", "fail", "fail"]);
		expect(["query", "queries", "parse", "parsed", "class", "classes"].map(stem)).toEqual([
			"query",
			"query",
			"pars",
			"pars",
			"class",
			"class",
		]);
		expect(wordTerms("loginRedirect")).toEqual(["loginredirect", "login", "redirect"]);
		expect(wordTerms("B314")).toEqual(["b314"]);
		const parsed = parseKeywords('how did we fix the "login redirect" failures');
		expect(parsed).toMatchObject({ terms: ["fix", "login", "redirect", "failur"], phrases: ["login redirect"] });
		// Messages name a term as typed, not by its stem.
		expect(parsed.labels.get("failur")).toBe("failures");
		// Only stopwords: they are kept rather than leaving nothing to search.
		expect(parseKeywords("what was").terms).toEqual(["what", "was"]);
	});
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { renderMessages } from "../../src/octocode/compaction/archive/render.ts";
import { RECORD_FILE, writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import {
	archiveFolder,
	LIBRARY_FILE,
	libraryPath,
	type Segment,
	writeSegment,
} from "../../src/octocode/history/archive.ts";
import { parseKeywords, rankHistory, stem, wordTerms } from "../../src/octocode/history/rank.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { referenceRank } from "./archive-rank-oracle.ts";
import { termTest } from "../../src/octocode/history/rank/terms.ts";
import { archiveRankedLines, archiveRankedWindow } from "../../src/octocode/history/archive/ranked.ts";

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

describe("the next page of a ranked search", () => {
	it("is read from the ranking already made while the files are unchanged", async () => {
		const dir = tmp();
		const files = ["a", "b"].map((name) => {
			const file = path.join(dir, `${name}.md`);
			fs.writeFileSync(
				file,
				Array.from({ length: 400 }, (_, i) => `### line ${i}\nalpha topic ${name} ${i}`).join("\n"),
			);
			return { file, session: { id: name, relation: "same repository" as const }, label: name };
		});
		const first = await rankHistory(files, "alpha topic", 1);
		expect(first.pages).toBeGreaterThan(1);
		const opened = vi.spyOn(fs, "openSync");
		const second = await rankHistory(files, "alpha topic", 2);
		expect(second.page).toBe(2);
		expect(second.text).not.toBe(first.text);
		expect(opened).not.toHaveBeenCalled();
		// A changed file is read again.
		fs.appendFileSync(files[0].file, "\nalpha topic again");
		await rankHistory(files, "alpha topic", 2);
		expect(opened).toHaveBeenCalled();
		opened.mockRestore();
	});
});

describe("ranked search memory and cancellation", () => {
	const write = (dir: string, name: string, body: string) => {
		const file = path.join(dir, `${name}.md`);
		fs.writeFileSync(file, body);
		return { file, session: { id: name, relation: "same repository" as const }, label: name };
	};

	it("reads on this thread only the files holding a shown passage: the first pass runs in the index worker", async () => {
		const dir = tmp();
		const files = [
			write(dir, "hit", "### assistant\nthe zebra migration finished"),
			...["a", "b", "c", "d"].map((name) => write(dir, name, `### assistant\nnothing relevant in ${name}`)),
		];
		const opened = vi.spyOn(fs, "openSync");
		const found = await rankHistory(files, "zebra migration", 1);
		const paths = opened.mock.calls.map(([file]) => String(file));
		opened.mockRestore();
		expect(found.hits).toBe(1);
		expect(found.text).toContain("the zebra migration finished");
		// Only the matching file, to show its lines.
		expect(paths.filter((file) => file === files[0].file)).toHaveLength(1);
		for (const other of files.slice(1)) expect(paths.filter((file) => file === other.file)).toHaveLength(0);
	});

	it("says when a ranked file changed before its lines were shown", async () => {
		const dir = tmp();
		const files = [write(dir, "moving", "### assistant\nthe walrus deploy failed")];
		const real = fs.openSync;
		let calls = 0;
		const opened = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof real>) => {
			// Between the two passes, the file grows.
			if (++calls === 1) fs.appendFileSync(files[0].file, "\nmore lines written later");
			return real(...args);
		});
		const found = await rankHistory(files, "walrus deploy", 1);
		opened.mockRestore();
		expect(found.text).toContain("the walrus deploy failed");
		expect(found.text).toContain("the file changed after it was ranked");
	});

	it("stops a ranking inside one long file when cancelled, and the next search still answers", async () => {
		const dir = tmp();
		const long = Array.from({ length: 60_000 }, (_, i) => `### assistant\nthe okapi step ${i} okapi okapi`).join("\n");
		const files = [write(dir, "long", long)];
		const controller = new AbortController();
		const started = Date.now();
		const ranking = rankHistory(files, "okapi step", 1, undefined, controller.signal);
		setTimeout(() => controller.abort(new Error("cancelled")), 300);
		await expect(ranking).rejects.toThrow("cancelled");
		const cancelledAfter = Date.now() - started;
		const full = Date.now();
		const found = await rankHistory(files, "okapi step", 1);
		expect(found.hits).toBe(60_000);
		// The cancelled ranking stopped well before a whole ranking takes.
		expect(cancelledAfter).toBeLessThan(300 + (Date.now() - full));
	});
});

/** A small corpus with what ranking reads differently: identifiers, paths, `ies` stems, fences, headings, phrases, Greek. */
function corpus(): Array<{ file: string; session: { id: string; relation: "same repository" }; label: string }> {
	const words = [
		"registry",
		"registries",
		"queries",
		"query",
		"loginRedirect",
		"auth-storage/keychain.ts",
		"B314",
		"cache",
		"caches",
		"prompt",
		"failing",
		"failed",
		"ΟΔΟΣ",
		"οδός",
		"deploy",
		"walrus",
		"zebra",
		"migration",
		"the",
		"of",
		"rule",
		"notices",
		"attention",
		"context_bands",
		"TriggerDelivery",
		"plan",
	];
	let seed = 7;
	const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
	const sentence = (n: number) => Array.from({ length: n }, () => words[next() % words.length]).join(" ");
	const files: Array<{ file: string; session: { id: string; relation: "same repository" }; label: string }> = [];
	for (const id of ["s1", "s2", "s3"]) {
		setCurrentSession(id);
		for (let k = 0; k < 3; k++) {
			const messages: string[] = [];
			for (let m = 0; m < 25; m++) {
				const kind = next() % 5;
				if (kind === 0) messages.push(`### user\n${sentence(12)}\n${sentence(5)}`);
				else if (kind === 1)
					messages.push(
						`### assistant\n\`\`\`ts\n${sentence(8)}\n## not a heading ${sentence(3)}\n\`\`\`\n${sentence(6)}`,
					);
				else if (kind === 2)
					messages.push(`Tool \`bash\` ${sentence(4)}\n${Array.from({ length: 50 }, () => sentence(6)).join("\n")}`);
				else if (kind === 3)
					messages.push(`### assistant\n${"x".repeat(450)} ${sentence(3)}\nprompt cache ${sentence(4)}`);
				else messages.push(`### assistant\n${sentence(20)}`);
			}
			const written = writeSegment(
				{ ...segment(id), tldr: `${sentence(3)} work`, topics: [sentence(2)] },
				messages.join("\n\n"),
			).file;
			files.push({
				file: written,
				session: { id, relation: "same repository" },
				label: `segment ${k + 1} · ${sentence(2)}`,
			});
		}
		writeSessionRecord({
			session: id,
			repository: "/repo",
			workspace: "/repo",
			goal: { role: "user", text: `goal ${sentence(6)}` },
			ending: [{ role: "assistant", text: `\`\`\`\n${sentence(5)}\n\`\`\`\n${sentence(5)}` }],
			toolCalls: 3,
		});
		files.push({
			file: path.join(archiveFolder(id), RECORD_FILE),
			session: { id, relation: "same repository" },
			label: "record: goal and ending",
		});
		files.push({
			file: path.join(archiveFolder(id), LIBRARY_FILE),
			session: { id, relation: "same repository" },
			label: "library",
		});
	}
	setCurrentSession("me");
	return files;
}

describe("archive keywords: prefilter and byte-range second pass", () => {
	const queries = [
		"registry",
		"rule registry attention notices migrate context bands trigger delivery plan",
		"loginRedirect auth-storage/keychain.ts",
		'"prompt cache" deploy',
		"οδοσ",
		"failing caches",
		"the of",
		"kerberos",
	];

	it("ranks, scores and shows lines exactly as the full tokenizing scan did, on every page", async () => {
		const files = corpus();
		let hits = 0;
		for (const keywords of queries)
			for (const filter of [undefined, /walrus|zebra/i]) {
				const reference = await referenceRank(files, keywords, 1, filter);
				for (let page = 1; page <= Math.max(1, reference.pages); page++) {
					const expected = page === 1 ? reference : await referenceRank(files, keywords, page, filter);
					const found = await rankHistory(files, keywords, page, filter);
					expect({ keywords, at: page, ...found }).toEqual({ keywords, at: page, ...expected });
				}
				hits += reference.hits;
			}
		expect(hits).toBeGreaterThan(500);
	});

	it("reads each passage's ranked text the same from its byte range as from the whole file", () => {
		for (const { file } of corpus()) {
			const lines = fs.readFileSync(file, "utf8").split("\n");
			const { ranked, context } = archiveRankedLines(file, lines);
			for (let start = 0; start < lines.length; start += 7) {
				const end = Math.min(lines.length, start + 40);
				expect(archiveRankedWindow(file, lines.slice(start, end), context(start))).toEqual(ranked.slice(start, end));
			}
		}
	});

	it("lets through every word whose terms include a query term", () => {
		const samples = [
			"registries",
			"Registry",
			"loginRedirect",
			"auth-storage/keychain.ts",
			"ΟΔΟΣ",
			"ΑΣBc",
			"İstanbul",
			"queries",
			"failing",
			"CACHES",
			"B314x",
			"x.y-z/w",
		];
		for (const word of samples)
			for (const term of wordTerms(word))
				expect(termTest([term]).test(word.toLowerCase()), `${word} → ${term}`).toBe(true);
	});
});

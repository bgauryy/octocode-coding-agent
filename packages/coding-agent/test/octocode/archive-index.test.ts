import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveIndex, type ArchiveIndexDb } from "../../../db/src/api.ts";
import { writeSegment } from "../../src/octocode/history/archive.ts";
import { closeArchiveIndex } from "../../src/octocode/history/index/client.ts";
import { rankIndexed } from "../../src/octocode/history/index/query.ts";
import { openIndex, syncFiles } from "../../src/octocode/history/index/sync.ts";
import { rankHistory } from "../../src/octocode/history/rank.ts";
import type { Scored } from "../../src/octocode/history/rank/score.ts";
import { LineRunsBuilder } from "../../src/octocode/history/rank/line-runs.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { referenceRank } from "./archive-rank-oracle.ts";
import { tmp } from "./helpers.ts";

let saved: string | undefined;
const opened: ArchiveIndexDb[] = [];
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
	setCurrentSession("me");
});
afterEach(async () => {
	for (const index of opened.splice(0)) index.close();
	await closeArchiveIndex();
	setCurrentSession(undefined);
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

const words = [
	"registry",
	"registries",
	"loginRedirect",
	"auth-storage/keychain.ts",
	"cache",
	"prompt",
	"deploy",
	"walrus",
	"the",
];
let seed = 3;
const pick = () => words[(seed = (seed * 1103515245 + 12345) % 2147483648) % words.length];
const sentence = (n: number) => Array.from({ length: n }, pick).join(" ");

/** Segments of a few sessions with fences, headings and tool output, as ranked files. */
function corpus(sessions = 3) {
	const files: Array<{ file: string; session: { id: string; relation: "same repository" }; label: string }> = [];
	for (let s = 0; s < sessions; s++) {
		const id = `s${s}`;
		setCurrentSession(id);
		for (let k = 0; k < 2; k++) {
			const body = Array.from({ length: 20 }, (_, m) =>
				m % 3 === 0
					? `### assistant\n\`\`\`\n${sentence(6)}\n\`\`\`\n${sentence(8)}`
					: m % 3 === 1
						? `Tool \`bash\` ${sentence(3)}\n${Array.from({ length: 45 }, () => sentence(5)).join("\n")}`
						: `### user\n${sentence(15)}`,
			).join("\n\n");
			const { file } = writeSegment(
				{
					session: id,
					entry: `e-${id}-${k}`,
					tokensBefore: 1,
					method: "standalone",
					tldr: sentence(3),
					topics: [],
					readFiles: [],
					modifiedFiles: [],
					messages: 1,
				},
				body,
			);
			files.push({ file, session: { id, relation: "same repository" }, label: `segment ${k + 1} · ${sentence(2)}` });
		}
	}
	setCurrentSession("me");
	return files;
}

const open = (file = path.join(tmp(), "archive-index.db")) => {
	const index = openIndex(file);
	opened.push(index);
	return index;
};
const none = () => undefined;
const summary = (scored: Scored) => ({
	df: scored.df,
	hits: scored.hits,
	files: scored.files,
	top: scored.top.map(({ file, start, end, score }) => ({ file, start, end, score })),
});
const queries = [
	"registry",
	"loginRedirect cache",
	'"prompt cache" deploy',
	"auth-storage/keychain.ts walrus",
	"kerberos",
];

describe("archive index", () => {
	it("gives the scan's exact scores from the index, from a mix of both, and with a query filter", async () => {
		const files = corpus();
		// The first 400 lines of the first file match, as a query filter's scan reports them (`rank/line-runs.ts`).
		const lines = new LineRunsBuilder();
		for (let line = 0; line < 400; line++) lines.add(line);
		const filtered = new Map([[0, lines.done()]]);
		for (const keywords of queries)
			for (const filter of [undefined, filtered]) {
				const scanned = summary(await rankIndexed(open(), files, keywords, filter, none, 0));
				const index = open();
				await syncFiles(
					index,
					files.slice(0, 3).map(({ file }) => file),
					none,
				);
				expect(summary(await rankIndexed(index, files, keywords, filter, none, 0))).toEqual(scanned);
				expect(summary(await rankIndexed(index, files, keywords, filter, none))).toEqual(scanned);
				expect(summary(await rankIndexed({ ...index, fts: false }, files, keywords, filter, none))).toEqual(scanned);
			}
	});

	it("re-indexes a changed file, drops a deleted one and adds a new one", async () => {
		const files = corpus(2);
		const index = open();
		await syncFiles(
			index,
			files.map(({ file }) => file),
			none,
		);
		const before = new Map(archiveIndex.files(index.db).map((row) => [row.path, row.id]));
		fs.appendFileSync(files[0].file, "\n### user\nthe kerberos ticket expired\n");
		fs.rmSync(files[1].file);
		const added = corpus(3).at(-1)!;
		const all = [...files, added];
		const found = await rankIndexed(index, all, "kerberos", undefined, none);
		expect(found.top.map(({ file }) => all[file].file)).toEqual([files[0].file]);
		const after = new Map(archiveIndex.files(index.db).map((row) => [row.path, row.id]));
		expect(after.has(files[1].file)).toBe(false);
		expect(after.has(added.file)).toBe(true);
		expect(after.get(files[0].file)).not.toBe(before.get(files[0].file));
		for (const { file } of files.slice(2)) expect(after.get(file)).toBe(before.get(file));
	});

	it("empties the index when the tokenizer version differs", async () => {
		const files = corpus(1);
		const file = path.join(tmp(), "archive-index.db");
		const first = open(file);
		await syncFiles(
			first,
			files.map(({ file: f }) => f),
			none,
		);
		archiveIndex.writeMeta(first.db, "tokenizer", "0");
		expect(archiveIndex.files(open(file).db)).toEqual([]);
	});

	it("leaves every stored file whole when a sync is cancelled midway, and ranks right afterwards", async () => {
		const files = corpus();
		const index = open();
		let checks = 0;
		const stop = () => {
			if (++checks > 2) throw new Error("cancelled");
		};
		await expect(
			syncFiles(
				index,
				files.map(({ file }) => file),
				stop,
			),
		).rejects.toThrow("cancelled");
		const stored = archiveIndex.files(index.db);
		expect(stored).toHaveLength(2);
		const fresh = open();
		await syncFiles(
			fresh,
			stored.map((row) => row.path),
			none,
		);
		expect(archiveIndex.files(fresh.db).map(({ passages, words: w }) => [passages, w])).toEqual(
			stored.map(({ passages, words: w }) => [passages, w]),
		);
		const scanned = summary(await rankIndexed(open(), files, "registry walrus", undefined, none, 0));
		expect(summary(await rankIndexed(index, files, "registry walrus", undefined, none, 0))).toEqual(scanned);
	});

	it("answers concurrent searches through the worker as the full scan did, and refuses an empty query", async () => {
		const files = corpus();
		const found = await Promise.all(queries.map((keywords) => rankHistory(files, keywords, 1)));
		for (const [at, keywords] of queries.entries()) expect(found[at]).toEqual(await referenceRank(files, keywords, 1));
		await expect(rankHistory(files, "  ", 1)).rejects.toThrow("keywords needs at least one word");
		expect((await rankHistory([], "registry", 1)).hits).toBe(0);
	});
});

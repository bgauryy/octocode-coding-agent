import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	flushSessionRecords,
	RECORD_FILE,
	readRecordHeader,
	scheduleSessionRecord,
	type SessionRecord,
} from "../../src/octocode/history/archive/record.ts";
import { sessionOutputDir, setCurrentSession } from "../../src/octocode/shared/home.ts";
import { tmp } from "./helpers.ts";

const record = (ended: string): SessionRecord => ({
	session: "me",
	repository: "repo-id",
	workspace: "/w",
	goal: { role: "user", text: "the goal" },
	ending: [{ role: "assistant", text: ended }],
	toolCalls: 0,
});
const recordFile = () => path.join(sessionOutputDir("archive"), RECORD_FILE);

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
	setCurrentSession("me");
});
afterEach(async () => {
	await flushSessionRecords();
	setCurrentSession(undefined);
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

describe("the session record's background write", () => {
	it("writes the newest record once when several are rendered while a write is in flight", async () => {
		const writes = ["one", "two", "three"].map((ended) => scheduleSessionRecord(record(ended)));
		await Promise.all(writes);
		expect(readRecordHeader(path.dirname(recordFile()))).toMatchObject({ session: "me", ended: "three" });
		expect(fs.readdirSync(path.dirname(recordFile()))).toEqual([RECORD_FILE]);
	});

	it("does not write a record whose text is unchanged since the last write", async () => {
		await scheduleSessionRecord(record("done"));
		fs.writeFileSync(recordFile(), "replaced by the test");
		await scheduleSessionRecord(record("done"));
		expect(fs.readFileSync(recordFile(), "utf8")).toBe("replaced by the test");
		await scheduleSessionRecord(record("done again"));
		expect(readRecordHeader(path.dirname(recordFile()))).toMatchObject({ ended: "done again" });
	});

	it("reports a failed write and writes the same record on the next run", async () => {
		const folder = path.dirname(recordFile());
		fs.mkdirSync(path.join(recordFile(), "in-the-way"), { recursive: true });
		await expect(scheduleSessionRecord(record("lost"))).rejects.toThrow();
		expect(fs.readdirSync(folder)).toEqual([RECORD_FILE]);
		fs.rmSync(recordFile(), { recursive: true });
		await scheduleSessionRecord(record("lost"));
		expect(readRecordHeader(folder)).toMatchObject({ ended: "lost" });
	});

	it("lets shutdown wait for a write in flight", async () => {
		void scheduleSessionRecord(record("at exit"));
		await flushSessionRecords();
		expect(readRecordHeader(path.dirname(recordFile()))).toMatchObject({ ended: "at exit" });
	});
});

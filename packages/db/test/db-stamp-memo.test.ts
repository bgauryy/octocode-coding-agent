import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbStamp, openDatabase } from "../src/db.ts";
import { tmp } from "./helpers.ts";

let file: string;
beforeEach(() => {
	file = path.join(tmp(), "stamp.db");
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("dbStamp", () => {
	it("costs one stat pair for any number of callers in one turn, and re-reads in the next", async () => {
		fs.writeFileSync(file, "a");
		const stat = vi.spyOn(fs, "statSync");
		const first = Array.from({ length: 6 }, () => dbStamp(file));
		expect(new Set(first).size).toBe(1);
		expect(stat).toHaveBeenCalledTimes(2);
		fs.writeFileSync(file, "bb");
		await Promise.resolve();
		expect(dbStamp(file)).not.toBe(first[0]);
		expect(stat).toHaveBeenCalledTimes(4);
	});

	it("sees this process's own committed transaction within the same turn", () => {
		const agent = openDatabase({
			file,
			mirrorFile: path.join(path.dirname(file), "stamp.transcripts.db"),
			archiveDir: path.join(path.dirname(file), "archive"),
			privateParent: false,
		});
		try {
			const before = dbStamp(file);
			agent.transaction(() =>
				agent.db.exec("CREATE TABLE IF NOT EXISTS stamp_probe (x INTEGER); INSERT INTO stamp_probe VALUES (1)"),
			);
			expect(dbStamp(file)).not.toBe(before);
		} finally {
			agent.close();
		}
	});
});

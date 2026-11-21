import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceNotes } from "../../src/octocode/subagents/evidence.ts";
import { tmp } from "./helpers.ts";

const write = (file: string, bytes: string, mtimeMs?: number) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
	if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
};

describe("the harness opens the screenshots a desktop report cites", () => {
	it("says nothing about files that exist, are newer than the run and differ from each other", () => {
		const cwd = tmp();
		const startedAt = Date.now() - 5_000;
		write(path.join(cwd, "shots/a.png"), "first image");
		write(path.join(cwd, "shots/b.png"), "second image");
		const report = `success. Proof: ${cwd}/shots/a.png and shots-relative ./shots/b.png`;
		expect(evidenceNotes(report, startedAt, cwd)).toEqual([]);
	});

	it("names a missing file, a file older than the run and one identical to another it cites", () => {
		const cwd = tmp();
		const startedAt = Date.now() - 5_000;
		write(path.join(cwd, "old.png"), "from an earlier run", Date.now() - 60_000);
		write(path.join(cwd, "one.png"), "same bytes");
		write(path.join(cwd, "two.png"), "same bytes");
		const [line] = evidenceNotes(`./old.png ./missing.png ./one.png ./two.png`, startedAt, cwd);
		expect(line).toContain("./missing.png does not exist");
		expect(line).toContain("./old.png is older than this run");
		expect(line).toContain("./two.png is identical to ./one.png");
		expect(evidenceNotes(`./old.png ./missing.png ./one.png ./two.png`, startedAt, cwd)).toHaveLength(1);
	});

	it("finds nothing to check in a report that cites no image", () => {
		expect(evidenceNotes("done. Calculator showed 42.", Date.now(), tmp())).toEqual([]);
	});

	it("checks a path under .octocode and ignores other file types", () => {
		const cwd = tmp();
		write(path.join(cwd, ".octocode/tmp/x/calc.png"), "image bytes");
		expect(evidenceNotes(".octocode/tmp/x/calc.png notes.txt", Date.now() - 5_000, cwd)).toEqual([]);
		expect(evidenceNotes(".octocode/tmp/x/gone.png", Date.now() - 5_000, cwd)[0]).toContain("does not exist");
	});
});

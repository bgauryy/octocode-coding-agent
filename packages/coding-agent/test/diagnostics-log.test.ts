import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { problemLines, readProblems, recordProblem } from "../src/core/diagnostics-log.ts";

describe("diagnostics log", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "problems-"));
		file = join(dir, "agent", "problems.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("keeps the newest 50 and drops records older than seven days", () => {
		const now = Date.now();
		recordProblem("sessions", "ancient", file, now - 8 * 24 * 60 * 60 * 1000);
		for (let index = 0; index < 55; index++) recordProblem("sessions", `p${index}`, file, now);
		const problems = readProblems(file, now);
		expect(problems).toHaveLength(50);
		expect(problems[0]?.message).toBe("p5");
		expect(problemLines(problems)).toHaveLength(12);
	});

	it("never throws when the file cannot be written", () => {
		expect(recordProblem("sessions", "x", join(dir, "agent", "problems.json", "nested", "\0bad"))).toBe(false);
	});
});

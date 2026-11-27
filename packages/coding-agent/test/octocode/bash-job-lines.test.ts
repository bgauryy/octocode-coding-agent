import { describe, expect, it } from "vitest";
import { jobLines } from "../../src/octocode/files/bash/results.ts";
import type { BashJob } from "../../src/octocode/files/bash-jobs/types.ts";

const job = (log: string) => ({ log, pid: 42 }) as unknown as BashJob;

describe("background job lines", () => {
	it("name the log and how to stop the job, and no tail command that repeats the log path", () => {
		const lines = jobLines(job("/work/.octocode/bash/bash-1.log"), "/work");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^Log: .*bash-1\.log$/);
		expect(lines[1]).toBe("Stop: kill -- -42");
		expect(lines.join("\n")).not.toContain("tail");
	});
});

import { describe, expect, it } from "vitest";
import { parseProcessTable } from "../../../src/octocode/processes/table.ts";

describe("parseProcessTable", () => {
	it("reads pid, parent, RSS, UTC start time and the command line", () => {
		const text = [
			"    1     0   9000 Mon Jan  2 15:04:05 2006 /sbin/launchd",
			" 2147 27174  78864 Tue Nov  3 20:13:00 2026 octocode-main-01a1a2c5",
			" 2209  2147  35888 Tue Nov  3 20:13:01 2026 node /x/octocode-mcp/dist/index.js --flag a b",
			"garbage line",
		].join("\n");
		const rows = parseProcessTable(text);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toEqual({
			pid: 2147,
			ppid: 27174,
			rssKb: 78864,
			started: String(Date.UTC(2026, 10, 3, 20, 13, 0) / 1000),
			command: "octocode-main-01a1a2c5",
		});
		expect(rows[2].command).toBe("node /x/octocode-mcp/dist/index.js --flag a b");
	});

	it("drops rows whose start time cannot be read", () => {
		expect(parseProcessTable("  5  1  100 Xxx Foo  2 15:04:05 2006 cmd")).toEqual([]);
	});
});

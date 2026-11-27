import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { cachedMonth } from "../src/history-month.ts";
import { tmp } from "./helpers.ts";

it("treats a missing month as empty but throws on a damaged gzip", () => {
	const dir = tmp();
	expect(cachedMonth(path.join(dir, "audits-2026-10.jsonl.gz"))).toEqual([]);
	const bad = path.join(dir, "audits-2026-09.jsonl.gz");
	fs.writeFileSync(bad, "not gzip at all");
	expect(() => cachedMonth(bad)).toThrow();
});

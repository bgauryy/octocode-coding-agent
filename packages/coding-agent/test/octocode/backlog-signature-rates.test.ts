import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signatureRates } from "../../src/octocode/native/tools/backlog/signature-rates.ts";
import { signaturesOf } from "../../src/octocode/backlog/signature.ts";
import { tmp } from "./helpers.ts";

let cwd: string;
beforeEach(() => {
	const root = tmp("sigrate-");
	cwd = path.join(root, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
});
afterEach(() => vi.unstubAllEnvs());

const DAY = 86_400_000;

describe("error signature rates on a backlog item", () => {
	it("reads signatures from evidence entries only", () => {
		expect(signaturesOf({ evidence: ["src/a.ts:1 — x", "error signature: oldText not found", "error signature:  "] })).toEqual([
			"oldText not found",
		]);
	});

	it("says nothing for an item without a signature", async () => {
		expect(await signatureRates({ evidence: ["a"], state: "todo" }, cwd)).toBeUndefined();
	});

	it("shows an open item's last week, and a done item's rate before and since", async () => {
		const evidence = ["error signature: oldText not found"];
		expect(await signatureRates({ evidence, state: "todo" }, cwd)).toMatch(/^Error "oldText not found": 0 in 7d .* over the last week\.$/);
		const now = Date.now();
		expect(await signatureRates({ evidence, state: "done", doneAt: now - 3 * DAY }, cwd, undefined, now)).toMatch(
			/before done 0 in 7d \(0\.0\/day\); since done 0 in 3d \(0\.0\/day\)\./,
		);
		expect(await signatureRates({ evidence, state: "done", doneAt: now }, cwd, undefined, now)).toMatch(/since done not measured yet/);
	});
});

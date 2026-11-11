import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findOnPath } from "../src/find-on-path.ts";

const dir = mkdtempSync(join(tmpdir(), "octocode-find-on-path-"));
const tool = join(dir, "tool");
writeFileSync(tool, "#!/bin/sh\n");
chmodSync(tool, 0o755);
const plain = join(dir, "plain");
writeFileSync(plain, "not a program\n");
chmodSync(plain, 0o644);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("findOnPath", () => {
	it("finds an executable on PATH and skips empty entries and files that are not executable", () => {
		const env = { PATH: ["", join(dir, "missing"), dir].join(delimiter) };
		expect(findOnPath("tool", env)).toBe(tool);
		expect(findOnPath("plain", env)).toBeUndefined();
		expect(findOnPath("absent", env)).toBeUndefined();
	});

	it("checks a name that holds a path separator as that path instead of searching PATH", () => {
		expect(findOnPath(tool, { PATH: "" })).toBe(tool);
		expect(findOnPath(plain, { PATH: dir })).toBeUndefined();
		expect(findOnPath(join(dir, "absent"), { PATH: dir })).toBeUndefined();
	});
});

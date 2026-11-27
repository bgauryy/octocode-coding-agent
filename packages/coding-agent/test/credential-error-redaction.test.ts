import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSecretValues, registerSecretValue } from "@octocodeai/octocode-common/sanitize";
import { readCrashLog, recordCrash } from "../src/core/crash-log.ts";
import { CredentialSynchronizationError } from "../src/core/model-runtime.ts";

/** Opaque on purpose: no pattern recognizes it. */
const KEY = "synthetic0123456789abcdef0123456789";

describe("a crash record", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crash-secret-"));
		file = join(dir, "agent", "crashes.json");
		registerSecretValue(KEY);
	});
	afterEach(() => {
		clearSecretValues();
		rmSync(dir, { recursive: true, force: true });
	});

	it("holds no credential in its message, its stack or the file", () => {
		const error = new Error(`401 Incorrect API key provided: ${KEY} and Bearer abcdefghijklmnopqrstuvwxyz0123456789`);
		const record = recordCrash({ kind: "uncaught_exception", error, cwd: dir }, file);
		expect(record?.message).toContain("[redacted]");
		expect(record?.stack).toContain("[redacted]");
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(KEY);
		expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		expect(JSON.stringify(readCrashLog(file))).not.toContain(KEY);
	});

	it("redacts a thrown string too", () => {
		recordCrash({ kind: "fatal_error", error: `failed with ${KEY}`, cwd: dir }, file);
		expect(readFileSync(file, "utf8")).not.toContain(KEY);
	});
});

describe("CredentialSynchronizationError", () => {
	it("keeps the credential out of JSON, inspection and enumeration while code can still read it", () => {
		const credential = { type: "api_key" as const, key: KEY };
		const error = new CredentialSynchronizationError("provider", "login", credential, { cause: new Error("sync") });
		expect(JSON.stringify(error)).not.toContain(KEY);
		expect(inspect(error, { depth: 0 })).not.toContain(KEY);
		expect(Object.keys(error)).not.toContain("credential");
		expect({ ...error }).not.toHaveProperty("credential");
		expect(error.credential).toBe(credential);
		expect(error.providerId).toBe("provider");
	});
});

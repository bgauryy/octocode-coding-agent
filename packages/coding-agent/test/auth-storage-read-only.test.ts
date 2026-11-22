import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ReadOnlyAuthStorage } from "../src/core/auth-storage/read-only.ts";
import { clearConfigValueCache } from "../src/core/config-value.ts";

describe("read-only credential resolution", () => {
	let directory: string;
	let path: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "octocode-read-only-auth-"));
		path = join(directory, "auth.json");
	});
	afterEach(() => {
		clearConfigValueCache();
		rmSync(directory, { recursive: true, force: true });
	});

	test.each(["fixture-private-value", JSON.stringify({ example: { type: "fixture-private-value" } })])(
		"keeps malformed credential values out of diagnostics",
		async (content) => {
			writeFileSync(path, content);
			const readers = [
				new ReadOnlyAuthStorage(path).list(),
				AuthStorage.create(path).modify("example", async () => undefined),
			];
			for (const result of await Promise.allSettled(readers)) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected") {
					expect(inspect(result.reason)).toMatch(/auth.json/);
					expect(inspect(result.reason)).not.toContain("fixture-private-value");
				}
			}
			expect(readFileSync(path, "utf8")).toBe(content);
		},
	);

	test("resolves an API key command without writing credentials", async () => {
		const credential = { type: "api_key", key: "!printf read-only-command-value" };
		const content = JSON.stringify({ example: credential });
		writeFileSync(path, content);
		const storage = new ReadOnlyAuthStorage(path);
		expect(await storage.readRaw("example")).toEqual(credential);
		expect(await storage.list()).toEqual([{ providerId: "example", type: "api_key" }]);
		expect(await storage.read("example")).toEqual({ type: "api_key", key: "read-only-command-value" });
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	test("resolves a saved OAuth keychain stub without refreshing or writing it", async () => {
		const blob = { access: "saved-access", refresh: "saved-refresh", expires: 1, accountId: "fixture" };
		const stub = {
			type: "oauth",
			access: "",
			refresh: "",
			expires: 1,
			keychain: `!printf '%s' '${JSON.stringify(blob)}'`,
		};
		const content = JSON.stringify({ example: stub });
		writeFileSync(path, content);
		const storage = new ReadOnlyAuthStorage(path);
		expect(await storage.readRaw("example")).toEqual(stub);
		expect(await storage.read("example")).toEqual({ ...blob, type: "oauth" });
		expect(readFileSync(path, "utf8")).toBe(content);
		await expect(storage.modify("example", async () => undefined)).rejects.toThrow("Read-only");
	});

	test.each(["writable", "read-only"])("cancels a %s read while its credential helper runs", async (mode) => {
		writeFileSync(path, JSON.stringify({ example: { type: "api_key", key: "!sleep 0.3; printf delayed-fixture" } }));
		const storage = mode === "writable" ? AuthStorage.create(path) : new ReadOnlyAuthStorage(path);
		const controller = new AbortController();
		const pending = storage.read("example", { signal: controller.signal });
		const timer = setTimeout(() => controller.abort(new Error("fixture cancellation")), 20);
		try {
			await expect(pending).rejects.toThrow("fixture cancellation");
		} finally {
			clearTimeout(timer);
		}
	});
});

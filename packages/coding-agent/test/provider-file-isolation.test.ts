import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage/backends.ts";
import { removeModelsProvider } from "../src/core/provider-templates/models-file.ts";

const fixture = () => mkdtempSync(join(tmpdir(), "provider-guard-"));
let root: string | undefined;
afterEach(() => {
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
});
it("refuses test writes through direct and linked provider directories before opening or modifying a file", async () => {
	root = fixture();
	const home = join(root, "developer");
	const dir = join(home, ".octocode", "octocodecode");
	mkdirSync(dir, { recursive: true });
	const original = JSON.stringify({ providers: { first: {}, second: {} } });
	writeFileSync(join(dir, "models.json"), original);
	const guard = join(root, "guard.log");
	vi.stubEnv("OCTOCODE_TEST_PROTECTED_HOMES", home);
	vi.stubEnv("OCTOCODE_TEST_GUARD_FILE", guard);
	const alias = join(root, "linked");
	symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
	for (const location of [dir, alias]) {
		await expect(removeModelsProvider(join(location, "models.json"), "first")).rejects.toThrow(
			"real provider configuration",
		);
		const store = new FileAuthStorageBackend(join(location, "auth.json"));
		expect(() => store.withLock(() => ({ result: undefined, next: "{}" }))).toThrow("real provider configuration");
		await expect(store.withLockAsync(async () => ({ result: undefined, next: "{}" }))).rejects.toThrow(
			"real provider configuration",
		);
	}
	expect(readFileSync(join(dir, "models.json"), "utf8")).toBe(original);
	expect(existsSync(join(dir, "auth.json"))).toBe(false);
	expect(readFileSync(guard, "utf8").trim().split("\n")).toHaveLength(6);
});

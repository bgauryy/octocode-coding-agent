import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("settings file transactions", () => {
	const directories: string[] = [];
	function paths() {
		const root = mkdtempSync(join(tmpdir(), "octocode-settings-transaction-"));
		directories.push(root);
		return { root, agentDir: join(root, "agent"), projectDir: join(root, "project") };
	}
	afterEach(() => {
		for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each([true, false])(
		"locks a missing settings file before the first writer (parent exists: %s)",
		(parentExists) => {
			const { agentDir, projectDir } = paths();
			if (parentExists) mkdirSync(agentDir);
			const settingsPath = join(agentDir, "settings.json");
			let calls = 0;
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const competingStorage = new FileSettingsStorage(projectDir, agentDir);
			let competingCalls = 0;

			storage.withLock("global", (current) => {
				calls++;
				expect(current).toBeUndefined();
				// A second independent storage cannot read/merge the absent file until this callback commits.
				expect(lockfile.checkSync(settingsPath, { realpath: false })).toBe(true);
				let contentionError: unknown;
				try {
					competingStorage.withLock("global", (otherCurrent) => {
						competingCalls++;
						return JSON.stringify({ ...JSON.parse(otherCurrent ?? "{}"), packages: ["npm:other"] });
					});
				} catch (error) {
					contentionError = error;
				}
				expect(contentionError).toMatchObject({ code: "ELOCKED" });
				expect(competingCalls).toBe(0);
				return JSON.stringify({ theme: "light" });
			});

			expect(calls).toBe(1);
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "light" });
			expect(lockfile.checkSync(settingsPath, { realpath: false })).toBe(false);
			competingStorage.withLock("global", (current) => {
				competingCalls++;
				return JSON.stringify({ ...JSON.parse(current ?? "{}"), packages: ["npm:other"] });
			});
			expect(competingCalls).toBe(1);
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "light", packages: ["npm:other"] });
		},
	);

	it("releases the first-write lock when the callback fails", () => {
		const { agentDir, projectDir } = paths();
		const settingsPath = join(agentDir, "settings.json");
		const storage = new FileSettingsStorage(projectDir, agentDir);
		expect(() =>
			storage.withLock("global", () => {
				throw new Error("failed update");
			}),
		).toThrow("failed update");
		expect(lockfile.checkSync(settingsPath, { realpath: false })).toBe(false);
		storage.withLock("global", () => JSON.stringify({ theme: "light" }));
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "light" });
	});

	it("rejects a write requested through a read-only load without creating a parent", () => {
		const { agentDir, projectDir } = paths();
		const storage = new FileSettingsStorage(projectDir, agentDir);
		expect(() => storage.withLock("global", () => "{}", { readOnly: true })).toThrow("Read-only settings transaction");
		expect(existsSync(agentDir)).toBe(false);
	});

	it("reads without waiting for a writer's lock: writes are atomic renames", () => {
		const { agentDir, projectDir } = paths();
		mkdirSync(agentDir);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
		const release = lockfile.lockSync(settingsPath, { realpath: false });
		try {
			let read: string | undefined;
			const started = Date.now();
			new FileSettingsStorage(projectDir, agentDir).withLock(
				"global",
				(current) => {
					read = current;
					return undefined;
				},
				{ readOnly: true },
			);
			expect(JSON.parse(read ?? "{}")).toEqual({ theme: "dark" });
			// A held lock would have meant retries (and ELOCKED after them), not an immediate read.
			expect(Date.now() - started).toBeLessThan(100);
			expect(SettingsManager.create(projectDir, agentDir).getGlobalSettings()).toMatchObject({ theme: "dark" });
		} finally {
			release();
		}
	});

	it("does not create configuration directories for a read-only startup load", () => {
		const { agentDir, projectDir } = paths();
		SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
		expect(existsSync(agentDir)).toBe(false);
		expect(existsSync(join(projectDir, ".octocode"))).toBe(false);
	});

	it.each(["global", "project"] as const)(
		"leaves an externally emptied %s file intact and reports the write error",
		async (scope) => {
			const { agentDir, projectDir } = paths();
			mkdirSync(agentDir);
			mkdirSync(join(projectDir, ".octocode"), { recursive: true });
			const settingsPath =
				scope === "global" ? join(agentDir, "settings.json") : join(projectDir, ".octocode", "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
			writeFileSync(settingsPath, "");

			if (scope === "global") manager.setTheme("light");
			else manager.setProjectSkillPaths(["./extension.ts"]);
			await manager.flush();

			expect(readFileSync(settingsPath, "utf8")).toBe("");
			expect(manager.drainErrors()).toMatchObject([{ scope, path: settingsPath, error: expect.any(SyntaxError) }]);
		},
	);
});

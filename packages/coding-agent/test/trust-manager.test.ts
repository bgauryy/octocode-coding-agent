import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("treats a corrupt store as no decision, warns once, and never grants trust", () => {
		writeFileSync(join(agentDir, "trust.json"), "{not json");
		const warnings: string[] = [];
		const store = new ProjectTrustStore(agentDir, (message) => warnings.push(message));

		expect(store.get(cwd)).toBeNull();
		expect(store.get(cwd)).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("trust.json");
	});

	it("treats a store with an invalid value as no decision", () => {
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(cwd)]: "yes" }));
		const warnings: string[] = [];
		expect(new ProjectTrustStore(agentDir, (message) => warnings.push(message)).get(cwd)).toBeNull();
		expect(warnings).toHaveLength(1);
	});

	it("reads without the lock while a peer holds trust.json.lock", () => {
		const store = new ProjectTrustStore(agentDir, () => {});
		store.set(cwd, true);
		const release = lockfile.lockSync(agentDir, { realpath: false, lockfilePath: join(agentDir, "trust.json.lock") });
		try {
			expect(store.get(cwd)).toBe(true);
		} finally {
			release();
		}
	});

	it("keeps a corrupt store as trust.json.bak when a decision is saved", () => {
		writeFileSync(join(agentDir, "trust.json"), "{not json");
		const store = new ProjectTrustStore(agentDir, () => {});
		store.set(cwd, false);
		expect(readFileSync(join(agentDir, "trust.json.bak"), "utf-8")).toBe("{not json");
		expect(store.get(cwd)).toBe(false);
	});

	it("does not create a backup for a healthy store", () => {
		const store = new ProjectTrustStore(agentDir, () => {});
		store.set(cwd, true);
		expect(existsSync(join(agentDir, "trust.json.bak"))).toBe(false);
	});

	it("ignores fingerprinted { sha, trusted } entries written by earlier builds, and keeps them on write", () => {
		// Stored keys are canonical paths (macOS tmpdir is a symlink).
		const project = realpathSync(cwd);
		const parent = realpathSync(tempDir);
		writeFileSync(
			join(agentDir, "trust.json"),
			JSON.stringify({ [project]: { sha: "abc", trusted: true }, [parent]: { sha: "def", trusted: false } }),
		);
		const warnings: string[] = [];
		const store = new ProjectTrustStore(agentDir, (message) => warnings.push(message));
		// They approved specific config files, not the project: no core decision either way.
		expect(store.get(cwd)).toBeNull();
		const other = join(tempDir, "other");
		mkdirSync(other);
		expect(store.get(other)).toBeNull();
		store.set(other, true);
		expect(store.get(other)).toBe(true);
		expect(store.get(cwd)).toBeNull();
		expect(JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8"))).toEqual({
			[project]: { sha: "abc", trusted: true },
			[parent]: { sha: "def", trusted: false },
			[realpathSync(other)]: true,
		});
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [project]: { trusted: "yes" } }));
		// A malformed entry is reported and ignored, never trusted.
		expect(warnings).toEqual([]);
		expect(store.get(cwd)).toBeNull();
		expect(warnings).toEqual([expect.stringMatching(/must be true, false, or null/)]);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".octocode", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".octocode", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".octocode", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".octocode"), { recursive: true });
			writeFileSync(join(cwd, ".octocode", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".octocode"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { deferSettingsWrites } from "../src/core/settings-manager/storage-deferred.ts";

const resolver = new URL("../scripts/source-resolver.ts", import.meta.url).href;
const managerModule = new URL("../src/core/settings-manager.ts", import.meta.url).href;
const deferredModule = new URL("../src/core/settings-manager/storage-deferred.ts", import.meta.url).href;

const dirs: string[] = [];
function folders() {
	const root = mkdtempSync(join(tmpdir(), "octocode-deferred-settings-"));
	dirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd, file: join(agentDir, "settings.json") };
}
const readSettings = (file: string) => JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;

beforeAll(() => deferSettingsWrites());
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A child process that changes settings with deferred writes, then exits without waiting for them. */
function runChild(agentDir: string, cwd: string, body: string) {
	const script = join(agentDir, "..", `child-${Math.random().toString(36).slice(2)}.mts`);
	writeFileSync(
		script,
		`const { SettingsManager } = await import(${JSON.stringify(managerModule)});
const { deferSettingsWrites } = await import(${JSON.stringify(deferredModule)});
deferSettingsWrites();
const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)});
${body}
process.exit(0);
`,
	);
	return spawnSync(process.execPath, ["--import", resolver, script], { encoding: "utf-8", timeout: 60_000 });
}

describe("deferred settings writes", () => {
	it("lets the last value win and shows it to readers in this process before the file is written", async () => {
		const { agentDir, cwd, file } = folders();
		const manager = SettingsManager.create(cwd, agentDir);
		for (let i = 0; i < 7; i++) manager.setTheme(`theme-${i}`);
		// A manager created now (a session switch) reads what this process decided, not the file.
		expect(SettingsManager.create(cwd, agentDir).getTheme()).toBe("theme-6");
		await manager.flush();
		expect(readSettings(file).theme).toBe("theme-6");
		expect(manager.drainErrors()).toEqual([]);
		expect(readdirSync(agentDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("keeps the changes of two managers of one process that write while a write is pending", async () => {
		const { agentDir, cwd, file } = folders();
		const first = SettingsManager.create(cwd, agentDir);
		const second = SettingsManager.create(cwd, agentDir);
		first.setHideThinkingBlock(true);
		second.setTheme("light");
		first.setQuietStartup(true);
		await Promise.all([first.flush(), second.flush()]);
		expect(readSettings(file)).toMatchObject({ hideThinkingBlock: true, theme: "light", quietStartup: true });
	});

	it("waits for the settings lock another writer holds, without blocking the thread", async () => {
		const { agentDir, cwd, file } = folders();
		mkdirSync(agentDir, { recursive: true });
		const release = lockfile.lockSync(file, { realpath: false });
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setTheme("locked-out");
		let written = false;
		const flushed = manager.flush().then(() => {
			written = true;
		});
		// The event loop keeps running while the write waits for the lock.
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(written).toBe(false);
		expect(existsSync(file)).toBe(false);
		release();
		await flushed;
		expect(readSettings(file).theme).toBe("locked-out");
		expect(manager.drainErrors()).toEqual([]);
	});

	it("commits a pending write when the process exits without waiting for it", () => {
		const { agentDir, cwd, file } = folders();
		const child = runChild(agentDir, cwd, `manager.setHideThinkingBlock(true); manager.setTheme("light");`);
		expect(child.status, child.stderr).toBe(0);
		expect(readSettings(file)).toMatchObject({ hideThinkingBlock: true, theme: "light" });
		expect(readdirSync(agentDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(agentDir)).not.toContain("settings.json.lock");
	});

	it("loses no write of two processes writing different fields at once (the file lock still applies)", async () => {
		const { agentDir, cwd, file } = folders();
		const body = (field: string) => `
for (let i = 0; i < 40; i++) {
	manager.${field}(i % 2 === 0);
	if (i % 5 === 0) await manager.flush();
}
manager.${field}(true);
await manager.flush();`;
		const children = await Promise.all(
			["setHideThinkingBlock", "setQuietStartup"].map(
				(field) =>
					new Promise<number | null>((resolve) => {
						// Run both children at once: spawnSync would run them one after the other.
						void import("node:child_process").then(({ spawn }) => {
							const script = join(agentDir, "..", `writer-${field}.mts`);
							writeFileSync(
								script,
								`const { SettingsManager } = await import(${JSON.stringify(managerModule)});
const { deferSettingsWrites } = await import(${JSON.stringify(deferredModule)});
deferSettingsWrites();
const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)});
${body(field)}
if (manager.drainErrors().length) process.exit(3);
`,
							);
							const child = spawn(process.execPath, ["--import", resolver, script], { stdio: "inherit" });
							child.on("exit", (code) => resolve(code));
						});
					}),
			),
		);
		expect(children).toEqual([0, 0]);
		expect(readSettings(file)).toMatchObject({ hideThinkingBlock: true, quietStartup: true });
	}, 120_000);
});

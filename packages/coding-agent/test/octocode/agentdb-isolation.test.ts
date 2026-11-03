import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";

const homes: string[] = [];
const environment = () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-db-isolation-"));
	homes.push(home);
	return { OCTOCODE_HOME: home };
};
afterEach(() => {
	closeSharedAgentDb();
	for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

it("keeps each configured database usable until the storage owner closes it", () => {
	const a = environment();
	const b = environment();
	const first = sharedAgentDb(a);
	first.db.prepare("INSERT INTO meta VALUES (?, ?)").run("owner", "first");
	const second = sharedAgentDb(b);
	second.db.prepare("INSERT INTO meta VALUES (?, ?)").run("owner", "second");
	expect(first.db.prepare("SELECT value FROM meta WHERE key = 'owner'").get()).toEqual({ value: "first" });
	expect(sharedAgentDb(a)).toBe(first);
	expect(sharedAgentDb(b)).toBe(second);
	expect(second.db.prepare("SELECT value FROM meta WHERE key = 'owner'").get()).toEqual({ value: "second" });
	closeSharedAgentDb();
	expect(() => first.db.prepare("SELECT 1")).toThrow();
	expect(() => second.db.prepare("SELECT 1")).toThrow();
	expect(sharedAgentDb(a)).not.toBe(first);
});

it("does not close healthy databases when another configured file is refused", () => {
	const a = environment();
	const first = sharedAgentDb(a);
	const bad = path.join(environment().OCTOCODE_HOME, "foreign.db");
	fs.writeFileSync(bad, "not sqlite".repeat(100));
	expect(() => sharedAgentDb({ OCTOCODE_AGENT_DB: bad })).toThrow();
	expect(first.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
});

it("reuses one connection through a symlinked home and an explicit database path", () => {
	const env = environment();
	const alias = path.join(environment().OCTOCODE_HOME, "alias");
	fs.symlinkSync(env.OCTOCODE_HOME, alias, "dir");
	const first = sharedAgentDb(env);
	expect(sharedAgentDb({ OCTOCODE_HOME: alias })).toBe(first);
	expect(sharedAgentDb({ OCTOCODE_AGENT_DB: first.file })).toBe(first);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { violations } from "./check-db-boundary.mjs";

const at = (file, text) => ({ file, text });

test("flags SQL, exec and sqlite imports outside agentdb", () => {
	const files = [
		at("octocode/team/store.ts", 'db.prepare("SELECT 1")'),
		at("octocode/backlog/reads.ts", "this.db.prepare(`SELECT 1`)"),
		at("octocode/memory/store.ts", 'db.exec("PRAGMA x")'),
		at("octocode/sessions/store.ts", 'import type { DatabaseSync } from "node:sqlite";'),
		at("octocode/web/search.ts", "const { DatabaseSync } = loadSqlite();"),
	];
	assert.deepEqual(
		violations(files),
		files.map((f) => f.file),
	);
});

test("allows agentdb and the foreign-database reader", () => {
	const text = 'db.prepare("SELECT 1"); import type { DatabaseSync } from "node:sqlite";';
	const files = ["octocode/agentdb/queries/meta.ts", "octocode/team/peer-leases.ts"].map((f) => at(f, text));
	assert.deepEqual(violations(files), []);
});

test("flags loadSqlite outside agentdb, shared/util.ts included", () => {
	assert.deepEqual(violations([at("octocode/shared/util.ts", "export function loadSqlite() {}")]), [
		"octocode/shared/util.ts",
	]);
});

test("flags agentdb imports other than its API outside agentdb", () => {
	const files = [
		at("octocode/backlog/item.ts", 'import { USER_AUTHOR } from "../agentdb/author.ts";'),
		at("octocode/team/store.ts", 'import { type AgentDb } from "../agentdb/db.ts";'),
		at("octocode/backlog/row.ts", 'import type { ItemRow } from "../agentdb/queries/backlog.ts";'),
		at("main/session-manager.ts", 'import { sessionFileRunningPid } from "../octocode/agentdb/liveness.ts";'),
	];
	assert.deepEqual(
		violations(files),
		files.map((f) => f.file),
	);
	const allowed = [
		at("octocode/backlog/item.ts", 'import { USER_AUTHOR } from "../agentdb/api.ts";'),
		at("octocode/agentdb/api.ts", 'export { USER_AUTHOR } from "./author.ts";'),
		at("octocode/agentdb/liveness.ts", 'import { sessions } from "../agentdb/queries/sessions.ts";'),
	];
	assert.deepEqual(violations(allowed), []);
});

test("ignores unrelated prepare calls", () => {
	assert.deepEqual(violations([at("core/agent-session/run-loop.ts", "await retry.prepare(message)")]), []);
});

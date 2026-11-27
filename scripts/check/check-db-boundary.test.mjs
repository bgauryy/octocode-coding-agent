import assert from "node:assert/strict";
import { test } from "node:test";
import { violations } from "./check-db-boundary.mjs";

const at = (file, text) => ({ file, text });

test("flags SQL, exec and sqlite imports outside agentdb", () => {
	const files = [
		at("coding-agent/src/octocode/team/store.ts", 'db.prepare("SELECT 1")'),
		at("coding-agent/src/octocode/backlog/reads.ts", "this.db.prepare(`SELECT 1`)"),
		at("coding-agent/src/octocode/memory/store.ts", 'db.exec("PRAGMA x")'),
		at("coding-agent/src/octocode/sessions/store.ts", 'import type { DatabaseSync } from "node:sqlite";'),
		at("coding-agent/src/octocode/web/search.ts", "const { DatabaseSync } = loadSqlite();"),
	];
	assert.deepEqual(
		violations(files),
		files.map((f) => f.file),
	);
});

test("allows agentdb and the foreign-database reader", () => {
	const text = 'db.prepare("SELECT 1"); import type { DatabaseSync } from "node:sqlite";';
	const files = ["db/src/queries/meta.ts", "coding-agent/src/octocode/team/peer-leases.ts"].map((f) => at(f, text));
	assert.deepEqual(violations(files), []);
});

test("flags loadSqlite outside agentdb, shared/util.ts included", () => {
	assert.deepEqual(violations([at("coding-agent/src/octocode/shared/util.ts", "export function loadSqlite() {}")]), [
		"coding-agent/src/octocode/shared/util.ts",
	]);
});

test("flags agentdb imports other than its API outside agentdb", () => {
	const files = [
		at("coding-agent/src/octocode/backlog/item.ts", 'import { USER_AUTHOR } from "../../../../db/src/author.ts";'),
		at("coding-agent/src/octocode/team/store.ts", 'import { type AgentDb } from "../../../../db/src/db.ts";'),
		at(
			"coding-agent/src/octocode/backlog/row.ts",
			'import type { ItemRow } from "../../../../db/src/queries/backlog.ts";',
		),
		at(
			"coding-agent/src/main/session-manager.ts",
			'import { sessionFileRunningPid } from "@octocodeai/octocode-db/queries/agents";',
		),
	];
	assert.deepEqual(
		violations(files),
		files.map((f) => f.file),
	);
	const allowed = [
		at("coding-agent/src/octocode/backlog/item.ts", 'import { USER_AUTHOR } from "../../../../db/src/api.ts";'),
		at("db/src/api.ts", 'export { USER_AUTHOR } from "./author.ts";'),
		at("db/src/liveness.ts", 'import { sessions } from "../../../../db/src/queries/sessions.ts";'),
	];
	assert.deepEqual(violations(allowed), []);
});

test("ignores unrelated prepare calls", () => {
	assert.deepEqual(violations([at("core/agent-session/run-loop.ts", "await retry.prepare(message)")]), []);
});

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

test("allows agentdb, the foreign-database reader and loadSqlite's home", () => {
	const text = 'db.prepare("SELECT 1"); import type { DatabaseSync } from "node:sqlite";';
	const files = ["octocode/agentdb/queries/meta.ts", "octocode/team/peer-leases.ts", "octocode/shared/util.ts"].map(
		(f) => at(f, text),
	);
	assert.deepEqual(violations(files), []);
});

test("ignores unrelated prepare calls", () => {
	assert.deepEqual(violations([at("core/agent-session/run-loop.ts", "await retry.prepare(message)")]), []);
});

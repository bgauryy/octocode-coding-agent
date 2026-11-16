import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase, transcripts } from "../src/api.ts";
import { tmp } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/queue-then-exit.mts", import.meta.url));
const resolver = fileURLToPath(new URL("../../coding-agent/scripts/source-resolver.ts", import.meta.url));

/** Runs a child that queues a mirror save and then calls `process.exit`; returns the rows left in its database. */
function runChild(mode: "drain" | "none") {
	const dir = tmp();
	const child = spawnSync(process.execPath, ["--no-warnings", "--import", resolver, fixture, dir, mode], {
		encoding: "utf8",
	});
	expect(child.stderr).toBe("");
	expect(child.status).toBe(0);
	const db = openDatabase({
		file: path.join(dir, "exit.db"),
		mirrorFile: path.join(dir, "exit.transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
	try {
		return transcripts.records(db.mirror.db, "s-exit");
	} finally {
		db.close();
	}
}

describe("writes queued before process.exit", () => {
	it("are stored once the process drains its writers first", () => {
		expect(runChild("drain")).toHaveLength(2);
	});

	it("are dropped without the drain (why quit paths call it)", () => {
		expect(runChild("none")).toHaveLength(0);
	});
});

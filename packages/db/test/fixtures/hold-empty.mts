import { parentPort, workerData } from "node:worker_threads";
import { loadSqlite } from "../../src/sqlite.ts";

const { file, release } = workerData as { file: string; release: SharedArrayBuffer };
const { DatabaseSync } = loadSqlite();
const db = new DatabaseSync(file);
try {
	db.exec("BEGIN EXCLUSIVE");
	parentPort!.postMessage("held");
	if (Atomics.wait(new Int32Array(release), 0, 0, 10_000) === "timed-out") throw new Error("Cold lock fixture timed out");
	db.exec("ROLLBACK");
} finally {
	db.close();
}

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { AgentDbError, closeSharedAgentDb, isBusy } from "../../../db/src/api.ts";
import { prepareAgentDb, sharedAgentDb } from "../../src/storage/database.ts";
import { tmp } from "./helpers.ts";

it("lets existing consumers report permanent invalid database errors without changing the file", async () => {
	const file = path.join(tmp("octocode-prepare-invalid-"), "foreign.db");
	fs.writeFileSync(file, "foreign bytes");
	const env = { ...process.env, OCTOCODE_AGENT_DB: file };
	await expect(prepareAgentDb(env)).resolves.toBeUndefined();
	expect(() => sharedAgentDb(env)).toThrow(AgentDbError);
	expect(fs.readFileSync(file, "utf8")).toBe("foreign bytes");
});

it("propagates an exhausted cold lock budget before startup can fall back to a synchronous open", async () => {
	const file = path.join(tmp("octocode-prepare-busy-"), "workspaces.db");
	const release = new Int32Array(new SharedArrayBuffer(4));
	const worker = new Worker(new URL("../../../db/test/fixtures/hold-empty.mts", import.meta.url), {
		workerData: { file, release: release.buffer },
	});
	const exited = new Promise<void>((resolve, reject) => {
		worker.once("error", reject);
		worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Holder exited ${code}`))));
	});
	await Promise.race([
		new Promise((resolve) => worker.once("message", resolve)),
		exited.then(() => {
			throw new Error("Holder exited before ready");
		}),
	]);
	const env = { ...process.env, OCTOCODE_AGENT_DB: file };
	let reachedSynchronousOpen = false;
	let settled = false;
	const startup = (async () => {
		await prepareAgentDb(env);
		reachedSynchronousOpen = true;
		return sharedAgentDb(env);
	})().finally(() => {
		settled = true;
	});
	try {
		await sleep(10);
		expect(settled).toBe(false);
		const failure = await startup.catch((error) => error);
		expect(isBusy(failure)).toBe(true);
		expect(reachedSynchronousOpen).toBe(false);
		Atomics.store(release, 0, 1);
		Atomics.notify(release, 0);
		await exited;
		await prepareAgentDb(env);
		expect(sharedAgentDb(env).db.isOpen).toBe(true);
	} finally {
		Atomics.store(release, 0, 1);
		Atomics.notify(release, 0);
		await exited;
		await startup.catch(() => undefined);
		closeSharedAgentDb();
	}
});

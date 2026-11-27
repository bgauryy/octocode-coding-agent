import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeMember } from "../src/history-member.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withFileLock } from "../../common/src/file-write-lock.ts";
import { DAY_MS, HOUR_MS } from "../../common/src/time.ts";
import {
	type AgentDb,
	closeSharedAgentDb,
	configAudits,
	history,
	historyArchivesSettled,
	openDatabase,
	scheduleHistoryArchive,
	sharedDbWriter,
	DbWriter,
} from "../src/api.ts";
import { holdWrite } from "./hold-write.ts";
import { tmp } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 14, 12);
let agent: AgentDb;
const holders: Awaited<ReturnType<typeof holdWrite>>[] = [];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
	const root = tmp();
	agent = openDatabase({
		file: path.join(root, "agent.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const holder of holders.splice(0)) await holder.close();
	closeSharedAgentDb();
	agent.close();
});

async function scheduled(at = NOW): Promise<void> {
	scheduleHistoryArchive(
		() => agent,
		undefined,
		() => at,
	);
	await flush();
	const writer = sharedDbWriter({ ...agent, privateParent: false });
	expect(await writer.drain(5000)).toBe(true);
	await flush();
}

it("skips a peer database lock without sleeping on the caller and retries after an hour", async () => {
	configAudits.record(agent.db, {
		at: NOW - 20 * DAY_MS,
		actor: "fixture",
		action: "provider.toggle",
		target: "fixture",
		outcome: "ok",
	});
	const holder = await holdWrite(agent.file);
	holders.push(holder);
	const wait = vi.spyOn(Atomics, "wait");
	const committed = vi.fn();
	agent.onCommit(committed);
	await scheduled();
	expect(wait).not.toHaveBeenCalled();
	expect(committed).not.toHaveBeenCalled();
	await holder.close();
	await scheduled(NOW + HOUR_MS - 1);
	expect(committed).not.toHaveBeenCalled();
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toHaveLength(1);
	await scheduled(NOW + HOUR_MS);
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toHaveLength(0);
	expect(
		gunzipSync(fs.readFileSync(path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz"))).toString(),
	).toContain('"target":"fixture"');
});

it("leaves a locked expired archive intact without waiting and trims it on the scheduled retry", async () => {
	fs.mkdirSync(agent.archiveDir);
	const file = path.join(agent.archiveDir, "audits-2000-01.jsonl.gz");
	fs.writeFileSync(file, gzipSync(""));
	await withFileLock(file, async () => {
		const wait = vi.spyOn(Atomics, "wait");
		await scheduled();
		expect(wait).not.toHaveBeenCalled();
		expect(fs.existsSync(file)).toBe(true);
	});
	await scheduled(NOW + HOUR_MS - 1);
	expect(fs.existsSync(file)).toBe(true);
	await scheduled(NOW + HOUR_MS);
	expect(fs.existsSync(file)).toBe(false);
});

it("retains source history when the destination archive is locked and archives before deletion on retry", async () => {
	const at = NOW - 20 * DAY_MS;
	configAudits.record(agent.db, { at, actor: "fixture", action: "credential.set", target: "fixture", outcome: "ok" });
	fs.mkdirSync(agent.archiveDir);
	const file = path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz");
	const earlier = '{"db":"config_audits","id":"0","at":1,"row":{"target":"earlier"}}';
	fs.writeFileSync(file, encodeMember([earlier], 1, 1));
	await withFileLock(file, async () => {
		const wait = vi.spyOn(Atomics, "wait");
		await scheduled();
		expect(wait).not.toHaveBeenCalled();
		expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toHaveLength(1);
		expect(gunzipSync(fs.readFileSync(file)).toString()).not.toContain('"target":"fixture"');
	});
	await scheduled(NOW + HOUR_MS);
	expect(gunzipSync(fs.readFileSync(file)).toString()).toContain('"target":"fixture"');
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toHaveLength(0);
});

it("lets a disposing session wait for the admitted pass, within its bound", async () => {
	expect(await historyArchivesSettled(10)).toBe(true);
	let complete!: (result: { archived: number; deleted: number }) => void;
	vi.spyOn(DbWriter.prototype, "archive").mockReturnValue(
		new Promise((resolve) => {
			complete = resolve;
		}),
	);
	scheduleHistoryArchive(
		() => agent,
		undefined,
		() => NOW,
	);
	// Admitted but not yet started (it runs on the next turn of the event loop): still awaited.
	expect(await historyArchivesSettled(20)).toBe(false);
	const settled = historyArchivesSettled(5000);
	complete({ archived: 0, deleted: 0 });
	expect(await settled).toBe(true);
	expect(await historyArchivesSettled(10)).toBe(true);
});

it("admits only one maintenance pass while a previous day is still running", async () => {
	let complete!: (result: { archived: number; deleted: number }) => void;
	const pending = new Promise<{ archived: number; deleted: number }>((resolve) => {
		complete = resolve;
	});
	const archive = vi.spyOn(DbWriter.prototype, "archive").mockReturnValue(pending);
	scheduleHistoryArchive(
		() => agent,
		undefined,
		() => NOW,
	);
	await flush();
	scheduleHistoryArchive(
		() => agent,
		undefined,
		() => NOW + 2 * DAY_MS,
	);
	await flush();
	expect(archive).toHaveBeenCalledTimes(1);
	complete({ archived: 0, deleted: 0 });
	await flush();
});

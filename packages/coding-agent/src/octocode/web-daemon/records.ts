import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import {
	AttachRecordSchema,
	DaemonRecordSchema,
	type AttachRecord,
	type DaemonRecord,
} from "@octocodeai/octocode-contracts/daemon";
import { privateDir } from "../shared/home.ts";
import { isLoopbackHostname } from "../shared/net.ts";
import { sameProcessAsync } from "../shared/process.ts";
import { atomicWriteFileSync } from "../../../../common/src/atomic-file.ts";
import { PRIVATE_FILE_MODE } from "../../../../common/src/file-mode.ts";

function readJson<S extends TSchema>(file: string, schema: S): Static<S> | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return Value.Check(schema, parsed) ? parsed : undefined;
	} catch {
		// Missing, torn or foreign: the same as no record.
		return undefined;
	}
}

/**
 * Owner-only atomic replacement: a reader sees the old record or the new one, and a failed write leaves no temporary
 * file. Not flushed to disk (`durability: "none"`): a record names a live process, which a crash ends, and readers drop a
 * record that does not parse or whose process is gone, so a flush would only hold up the writer.
 */
function writeJson(file: string, value: unknown): void {
	privateDir(path.dirname(file));
	atomicWriteFileSync(file, `${JSON.stringify(value)}\n`, { mode: PRIVATE_FILE_MODE, durability: "none" });
}

export const readDaemonRecord = (file: string): DaemonRecord | undefined => readJson(file, DaemonRecordSchema);
export const writeDaemonRecord = (file: string, record: DaemonRecord): void => writeJson(file, record);
export const readAttachRecord = (file: string): AttachRecord | undefined => readJson(file, AttachRecordSchema);
export const writeAttachRecord = (file: string, record: AttachRecord): void => writeJson(file, record);

export function removeRecord(file: string, owns?: (text: string) => boolean): boolean {
	try {
		if (owns && !owns(fs.readFileSync(file, "utf8"))) return false;
		fs.rmSync(file, { force: true });
		return true;
	} catch {
		// Already gone.
		return false;
	}
}

/** The access token in a record's `url` fragment. */
export function recordToken(record: Pick<DaemonRecord, "url">): string | undefined {
	try {
		return new URLSearchParams(new URL(record.url).hash.slice(1)).get("access") ?? undefined;
	} catch {
		return undefined;
	}
}

/** The record's origin when its URL is plain loopback HTTP on the recorded port; anything else is not trusted. */
export function recordOrigin(record: Pick<DaemonRecord, "url" | "port">): string | undefined {
	try {
		const url = new URL(record.url);
		if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || Number(url.port) !== record.port)
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** Whether a record's process may still be the one that wrote it (alive, and not a later process that got the pid). */
export const recordProcessAlive = (
	record: Pick<DaemonRecord | AttachRecord, "pid" | "pid_started">,
): Promise<boolean> => sameProcessAsync(record.pid, record.pid_started);

/** Removes attach records whose process is gone (a session killed without its shutdown); returns how many. */
export async function sweepAttachRecords(dir: string): Promise<number> {
	let removed = 0;
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return 0;
	}
	for (const name of names) {
		const file = path.join(dir, name);
		const record = readAttachRecord(file);
		if (record && !(await recordProcessAlive(record))) {
			if (removeRecord(file, (text) => JSON.parse(text).token === record.token)) removed++;
		}
	}
	return removed;
}

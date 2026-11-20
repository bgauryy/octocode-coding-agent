import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OCTOCODE_DIR } from "../shared/home.ts";
import { processAlive } from "../shared/process.ts";
import type { RunLockSnap } from "./model.ts";

/** The host lock a full test run or check takes, under the account's home whatever `HOME` says. */
const hostRunLockDir = (): string => path.join(os.userInfo().homedir, OCTOCODE_DIR, "locks", "full-run");

interface OwnerRecord {
	pid?: unknown;
	label?: unknown;
	agent?: unknown;
	item?: unknown;
	job?: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Who holds the full-run lock now, or undefined when it is free or its holder is gone. Reads the owner record; changes nothing. */
export function readRunLockSnap(dir: string = hostRunLockDir()): RunLockSnap | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, "owner.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const owner = JSON.parse(raw) as OwnerRecord | null;
	if (!owner || !processAlive(owner.pid)) return undefined;
	const [agent, item, job] = [text(owner.agent), text(owner.item), text(owner.job)];
	return {
		label: text(owner.label) ?? "a full run",
		...(agent === undefined ? {} : { agent }),
		...(item === undefined ? {} : { item }),
		...(job === undefined ? {} : { job }),
	};
}

import type { SessionEntry } from "../../core/session-manager.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The file lists the branch's last compaction saved in its details, and whether a hook (Octocode) wrote it. */
export interface PreviousFileLists {
	fromHook: boolean;
	readFiles: string[];
	modifiedFiles: string[];
}

/** The last compaction's `readFiles`/`modifiedFiles` details on `branch`, or undefined without a compaction carrying details. */
export function previousFileLists(branch: readonly SessionEntry[]): PreviousFileLists | undefined {
	const previous = [...branch].reverse().find((entry) => entry.type === "compaction");
	if (previous?.type !== "compaction" || !isRecord(previous.details)) return undefined;
	const strings = (value: unknown) =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	return {
		fromHook: previous.fromHook === true,
		readFiles: strings(previous.details.readFiles),
		modifiedFiles: strings(previous.details.modifiedFiles),
	};
}

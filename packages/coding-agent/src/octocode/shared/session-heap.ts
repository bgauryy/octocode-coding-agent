import fs from "node:fs";
import { PARENT_HEAP_FILE_ENV } from "@octocodeai/octocode-common/env";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { HeapIndex, ParentHeap } from "./heap-index.ts";

/** One session's heap: what its context points at, and (in a child) what its parent held when it started. */
export interface SessionHeap {
	index: HeapIndex;
	parent?: ParentHeap;
}

const heaps = new WeakMap<object, SessionHeap>();

/** The parent's handles the child was given (`PARENT_HEAP_FILE_ENV`); none when absent or when the parent already removed the file. */
function loadParentHeap(env: NodeJS.ProcessEnv): ParentHeap | undefined {
	const file = env[PARENT_HEAP_FILE_ENV];
	if (!file) return undefined;
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const listed: unknown = JSON.parse(text);
	if (!Array.isArray(listed)) throw new Error(`${PARENT_HEAP_FILE_ENV} does not hold a list of handles`);
	return new ParentHeap(
		listed.flatMap((item) =>
			isRecord(item) && typeof item.handle === "string" && typeof item.path === "string"
				? [{ handle: item.handle, path: item.path }]
				: [],
		),
	);
}

/** The heap of the session `owner` (its session manager), made on first use; undefined without a session. */
export function sessionHeap(owner: object | undefined, env: NodeJS.ProcessEnv = process.env): SessionHeap | undefined {
	if (!owner) return undefined;
	let heap = heaps.get(owner);
	if (!heap) {
		const parent = loadParentHeap(env);
		heaps.set(owner, (heap = { index: new HeapIndex(), ...(parent ? { parent } : {}) }));
	}
	return heap;
}

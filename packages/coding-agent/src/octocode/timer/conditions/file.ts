import fs from "node:fs";
import path from "node:path";
import { watchWithErrorHandler, closeWatcher } from "../../../utils/fs-watch.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { FILE_STATES, type ConditionDeps, type ConditionSpec, type FileState, fields, text } from "./types.ts";

type File = { kind: "file"; path: string; is: FileState };

/** A changed file must show the same stat again after this long, so a write in progress does not wake anyone. */
const SETTLE_MS = 300;
/** The most characters of a file's end shown to the model as evidence (read only for a `check`). */
const TAIL_BYTES = 24_000;

/** `path` resolved, with the nearest existing ancestor's symlinks followed, so a link cannot lead out of the allowed roots. */
function canonical(absolute: string): string {
	const tail: string[] = [];
	let probe = absolute;
	for (;;) {
		try {
			return path.join(fs.realpathSync(probe), ...tail);
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return absolute;
			tail.unshift(path.basename(probe));
			probe = parent;
		}
	}
}

/** The absolute path of `raw` inside the workspace or its Octocode state folder, or the refusal. */
function allowedPath(raw: string, cwd: string, deps: ConditionDeps): { path: string } | { refused: string } {
	const absolute = canonical(resolveToolPath(cwd, raw));
	const inside = deps.roots(cwd).some((root) => {
		const relative = path.relative(canonical(root), absolute);
		return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	});
	return inside
		? { path: absolute }
		: { refused: `${raw} is outside the workspace; a file wait may watch only paths inside it` };
}

/** `(mtimeMs, size, ino)` of the file, or `absent`. */
function signature(absolute: string): string {
	const stat = fs.statSync(absolute, { throwIfNoEntry: false });
	return stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : "absent";
}

function tail(absolute: string): string {
	const stat = fs.statSync(absolute, { throwIfNoEntry: false });
	if (!stat?.isFile()) return "";
	const length = Math.min(stat.size, TAIL_BYTES);
	const fd = fs.openSync(absolute, "r");
	try {
		const buffer = Buffer.alloc(length);
		fs.readSync(fd, buffer, 0, length, stat.size - length);
		return buffer.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `file`: the path exists, is absent, or `changed` since the timer was set (its `(mtimeMs, size, ino)` differs from the
 * baseline and holds for 300 ms). Only stats are read; a `check` also gets the file's end as evidence. The event source
 * watches the parent directory, not the file, so an atomic rename-over still shows; an event only pokes a check.
 */
export const fileSpec: ConditionSpec<File> = {
	kind: "file",
	parse(value) {
		const given = fields(value, "file", ["path", "is"]);
		const is = given.is === undefined ? "changed" : given.is;
		if (!(FILE_STATES as readonly unknown[]).includes(is))
			throw new Error(`until.file.is is one of ${FILE_STATES.join(", ")}.`);
		return { kind: "file", path: text(given.path, "until.file.path"), is: is as FileState };
	},
	encode: (condition) => JSON.stringify({ path: condition.path, is: condition.is }),
	decode(stored) {
		const parsed = JSON.parse(stored) as { path?: unknown; is?: unknown };
		return typeof parsed.path === "string" && (FILE_STATES as readonly unknown[]).includes(parsed.is)
			? { kind: "file", path: parsed.path, is: parsed.is as FileState }
			: undefined;
	},
	describe: (condition) =>
		`${condition.path} ${condition.is === "changed" ? "changed" : condition.is === "exists" ? "exists" : "is gone"}`,
	safetyMs: 30_000,
	pollMs: 5000,
	baseline(condition, cwd, deps) {
		const allowed = allowedPath(condition.path, cwd, deps);
		if ("refused" in allowed) throw new Error(allowed.refused);
		return signature(allowed.path);
	},
	async check(condition, { cwd, baseline, deps, evidence }) {
		const allowed = allowedPath(condition.path, cwd, deps);
		if ("refused" in allowed) return { met: false, exit: null, output: "", refused: allowed.refused };
		const target = allowed.path;
		let now = signature(target);
		let met: boolean;
		if (condition.is === "changed") {
			met = baseline !== undefined && now !== baseline;
			if (met) {
				await sleep(SETTLE_MS);
				const later = signature(target);
				met = later === now;
				now = later;
			}
		} else met = condition.is === "exists" ? now !== "absent" : now === "absent";
		const output = `${condition.path} ${now === "absent" ? "does not exist" : "exists"}${met && condition.is === "changed" ? " and changed" : ""}.`;
		return {
			met,
			exit: null,
			output,
			...(met && evidence && now !== "absent" ? { evidence: `${output}\n${tail(target)}` } : {}),
		};
	},
	watch(condition, { cwd, deps }, poke, failed) {
		const allowed = allowedPath(condition.path, cwd, deps);
		if ("refused" in allowed) {
			failed();
			return () => undefined;
		}
		const name = path.basename(allowed.path);
		const watcher = watchWithErrorHandler(
			path.dirname(allowed.path),
			(_event, changed) => {
				if (!changed || changed === name) poke();
			},
			failed,
		);
		return () => closeWatcher(watcher);
	},
};

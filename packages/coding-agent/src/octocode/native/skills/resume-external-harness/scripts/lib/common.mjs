// Shared helpers for the session finder: repository root, path matching, file reading, digests and redaction.
import { execFileSync } from "node:child_process";
import {
	closeSync,
	createReadStream,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import zlib from "node:zlib";

/** The repository root of `dir` (git top level), or `dir` itself outside a repository. */
export function repoRoot(dir) {
	try {
		const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (top) return real(top);
	} catch {
		// Not a repository, or git is missing: the directory itself is the scope.
	}
	return real(dir);
}

export function real(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** True when `path` is `root` or inside it (`exact`: only `root`). */
function within(root, path, exact = false) {
	if (!path) return false;
	const target = path.startsWith("file://") ? decodeURIComponent(new URL(path).pathname) : path;
	const rel = relative(root, real(target));
	if (rel === "") return true;
	return !exact && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The scope (repository root, worktree) holding `path`: the deepest one, since a worktree can sit inside the root. */
export function inScope(ctx, path) {
	let best;
	for (const scope of ctx.scopes) {
		if (within(scope.path, path, ctx.exact) && (!best || scope.path.length > best.path.length)) best = scope;
	}
	return best;
}

/** True when a folder name encodes one of the scopes' paths (`exact`: the path itself, no subdirectory). */
export function slugInScope(ctx, name, exact = ctx.exact) {
	return ctx.scopes.some((scope) => slugMatcher(scope.path, exact)(name));
}

/**
 * Matches a folder name that encodes a path with its separators replaced (Claude Code `-Users-me-repo`,
 * Cursor `Users-me-repo`): the path's letters and digits in order, anything else between them.
 */
export function slugMatcher(root, exact = false) {
	const runs = root.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const body = runs.map((run) => run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9]+");
	const pattern = new RegExp(`^[^A-Za-z0-9]*${body}${exact ? "$" : "($|[^A-Za-z0-9])"}`, "i");
	return (name) => pattern.test(name);
}

/** The first line of a file without reading the rest (a Codex rollout's first line can be large). */
export function firstLine(file, limit = 4 * 1024 * 1024) {
	const fd = openSync(file, "r");
	try {
		const chunks = [];
		const buffer = Buffer.alloc(64 * 1024);
		let total = 0;
		while (total < limit) {
			const read = readSync(fd, buffer, 0, buffer.length, total);
			if (read === 0) break;
			const newline = buffer.subarray(0, read).indexOf(10);
			if (newline >= 0) {
				chunks.push(Buffer.from(buffer.subarray(0, newline)));
				break;
			}
			chunks.push(Buffer.from(buffer.subarray(0, read)));
			total += read;
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Each parseable JSON line of a JSONL file; broken lines (a write in progress) are skipped. */
export function* jsonLines(text) {
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			yield JSON.parse(line);
		} catch {
			// A partial last line while the other harness is still writing.
		}
	}
}

/** A session file's text; `.zst` files are decompressed in process (Node 23.8+) or by the `zstd` CLI. */
export function readText(file) {
	if (!file.endsWith(".zst")) return readFileSync(file, "utf8");
	if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(readFileSync(file)).toString("utf8");
	return execFileSync("zstd", ["-dcq", file], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
}

/** The first line of a `.zst` file, decompressing only as far as the first newline. */
export function zstdFirstLine(file, limit = 4 * 1024 * 1024) {
	if (!zlib.createZstdDecompress) return Promise.resolve(readText(file).split("\n", 1)[0]);
	return new Promise((resolveLine) => {
		const input = createReadStream(file);
		const inflate = zlib.createZstdDecompress();
		const chunks = [];
		let size = 0;
		let settled = false;
		const done = (line) => {
			if (settled) return;
			settled = true;
			input.destroy();
			inflate.destroy();
			resolveLine(line);
		};
		inflate.on("data", (chunk) => {
			const newline = chunk.indexOf(10);
			chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
			size += chunk.length;
			if (newline >= 0) done(Buffer.concat(chunks).toString("utf8"));
			else if (size > limit) done(undefined);
		});
		inflate.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
		inflate.on("error", () => done(undefined));
		input.on("error", () => done(undefined));
		input.pipe(inflate);
	});
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit(items, limit, fn) {
	const results = Array.from({ length: items.length });
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** "5m ago", "3h ago", "2d ago". */
export function ago(time, now = Date.now()) {
	const ms = now - Date.parse(time);
	if (!Number.isFinite(ms)) return "unknown";
	return ms < 0 ? "in the future" : `${duration(ms)} ago`;
}

/** A length of time in its two largest units: "1h 12m", "3d 4h", "45s". */
export function duration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	const units = [
		["d", 86_400_000],
		["h", 3_600_000],
		["m", 60_000],
		["s", 1000],
	];
	const parts = [];
	let rest = ms;
	for (const [unit, size] of units) {
		const count = Math.floor(rest / size);
		if (count || (parts.length === 0 && unit === "s")) parts.push(`${count}${unit}`);
		rest -= count * size;
		if (parts.length === 2) break;
	}
	return parts.join(" ");
}

/** Written in the last two minutes: the other harness may still be running this session. */
const LIVE_MS = 120_000;
export const isLive = (time, now = Date.now()) => now - Date.parse(time) < LIVE_MS;
export const mtime = (file) => statSync(file).mtime.toISOString();
export const exists = existsSync;

export function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

let sqliteMissing = false;
/**
 * Rows of a read-only query through the `sqlite3` CLI (`immutable=1`: never locks or writes the other app's
 * database). Returns undefined when `sqlite3` is not installed; the caller reports the skipped source.
 */
export function sqlite(file, sql) {
	if (sqliteMissing) return undefined;
	try {
		const out = execFileSync("sqlite3", ["-readonly", "-json", `file:${file}?immutable=1`, sql], {
			encoding: "utf8",
			maxBuffer: 512 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.trim() ? JSON.parse(out) : [];
	} catch (error) {
		if (error.code === "ENOENT") {
			sqliteMissing = true;
			return undefined;
		}
		throw new Error(`sqlite3 failed on ${file}: ${String(error.stderr || error.message).trim()}`, { cause: error });
	}
}

const SECRET_PATTERNS = [
	/\b(sk|rk|pk)-[A-Za-z0-9_-]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{30,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Masks common credential shapes so a digest does not carry a pasted token into another session. */
export function redact(text) {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, (match, prefix) =>
			typeof prefix === "string" && /bearer/i.test(prefix) ? `${prefix}[redacted]` : "[redacted]",
		);
	}
	return out;
}

export function clip(text, max) {
	const flat = String(text ?? "").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max)}… [+${flat.length - max} chars]`;
}

/** Long enough for an absolute path or a typical command line. */
const ARG_CHARS = 200;

/** A one-line summary of a tool call's input: the command, path, pattern or query it acted on. */
export function toolArg(input) {
	if (input == null) return "";
	if (typeof input === "string") return clip(input.replace(/\s+/g, " "), ARG_CHARS);
	if (Array.isArray(input)) return clip(input.join(" "), ARG_CHARS);
	for (const key of ["command", "cmd", "file_path", "path", "target_file", "pattern", "query", "url", "description"]) {
		const value = input[key];
		if (typeof value === "string" && value) return clip(value.replace(/\s+/g, " "), ARG_CHARS);
		if (Array.isArray(value) && value.length) return clip(value.join(" "), ARG_CHARS);
	}
	return clip(JSON.stringify(input), ARG_CHARS);
}

/** Paths an `apply_patch` body touches. */
export function patchFiles(patch) {
	return [...String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
}

/** Earliest and latest ISO timestamps seen. */
export function span(times) {
	const sorted = times.filter(Boolean).sort();
	return { startedAt: sorted[0], updatedAt: sorted.at(-1) };
}

/**
 * Folds a harness's events into the shared session shape: user turns, each with the assistant's text and
 * tool calls after it, the compaction summaries and the files the session edited.
 */
export function digest(events) {
	const turns = [];
	const summaries = [];
	const files = new Set();
	let current;
	for (const event of events) {
		if (event.kind === "user") {
			current = { user: event.text, assistant: [], tools: [] };
			turns.push(current);
		} else if (event.kind === "summary") {
			summaries.push(event.text);
		} else if (event.kind === "file") {
			files.add(event.path);
		} else {
			if (!current) {
				current = { user: "", assistant: [], tools: [] };
				turns.push(current);
			}
			if (event.kind === "assistant") current.assistant.push(event.text);
			else if (event.kind === "tool") current.tools.push(event.arg ? `${event.name} ${event.arg}` : event.name);
		}
	}
	return { turns, summaries, files: [...files] };
}

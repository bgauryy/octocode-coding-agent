import fs from "node:fs";
import { openScratchFile, writeScratchFile } from "../../shared/report-artifact.ts";
import path from "node:path";
import { tailNote } from "../../shared/format.ts";
import { visibleControls } from "../../../../../common/src/sanitize.ts";
import type { ChildState } from "../events.ts";
import { type ChildNotices, noticeText } from "../notices.ts";
import { cutText } from "../../../../../common/src/text.ts";

/** Characters of a child's stderr a failure shows (its end); a longer stderr is saved whole. */
const STDERR_TAIL_CHARS = 4_000;
const STDERR_FILE = "stderr.txt";
const NOTICES_FILE = "notices.txt";

/**
 * A child's stderr, bounded in memory: its last `STDERR_TAIL_CHARS` characters (control characters made visible), and,
 * once it outgrows that, all of it streamed to `stderr.txt` in `dir`, so a failure that shows only the end can name the whole.
 */
export class StderrTail {
	private tail = "";
	private total = 0;
	private fd: number | undefined;
	private file: string | undefined;
	private failed = false;

	private readonly dir: string | undefined;
	constructor(dir: string | undefined) {
		this.dir = dir;
	}

	write(chunk: string): void {
		const text = visibleControls(chunk);
		const before = this.tail;
		this.total += text.length;
		this.tail = cutText(before + text, STDERR_TAIL_CHARS, { chars: true, tail: true });
		if (this.total <= STDERR_TAIL_CHARS || this.failed) return;
		try {
			if (this.fd === undefined) {
				if (!this.dir) throw new Error("no folder");
				const file = path.join(this.dir, STDERR_FILE);
				this.fd = openScratchFile(file);
				this.file = file;
				// Nothing was cut before the first overflow, so the tail is everything that came earlier.
				fs.writeSync(this.fd, before);
			}
			fs.writeSync(this.fd, text);
		} catch {
			this.failed = true;
			this.file = undefined;
			this.close();
		}
	}

	close(): void {
		if (this.fd === undefined) return;
		try {
			fs.closeSync(this.fd);
		} catch {
			// Nothing to do: the file is a convenience copy.
		}
		this.fd = undefined;
	}

	/** The first line that names an error (`SyntaxError …`, `ERR_…`, `Cannot find module …`), else the first line that is not a stack frame; cut to one short line. */
	firstError(): string | undefined {
		const lines = this.tail
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const line =
			lines.find((each) => /\b(?:[A-Za-z]*Error|ERR_[A-Z0-9_]+)\b|Cannot find module/.test(each)) ??
			lines.find((each) => !/^at\s/.test(each));
		return line && (line.length > 300 ? `${line.slice(0, 300)}…` : line);
	}

	/** The file holding the whole stderr: the one streamed when it outgrew the tail, else written now; undefined when there is none or it cannot be saved. */
	save(): string | undefined {
		this.close();
		if (this.file) return this.file;
		if (this.failed || this.total === 0 || this.total > STDERR_TAIL_CHARS || !this.dir) return undefined;
		try {
			const file = path.join(this.dir, STDERR_FILE);
			writeScratchFile(file, this.tail);
			this.file = file;
			return file;
		} catch {
			return undefined;
		}
	}

	/** What an error shows: the whole stderr when it fit, else a note on the cut and where the whole is, then the end. */
	text(): string {
		const shown = this.tail.trim() || "no output";
		return this.total > STDERR_TAIL_CHARS
			? `${tailNote("stderr", this.tail.length, this.total, this.file)}\n${shown}`
			: shown;
	}
}

/**
 * The run's notices as the parent gets them at the end. When some did not fit the inline page, the notice log (each
 * notice whole, one per line, repeats folded with their count, and how many past its bounds it did not keep) is saved to
 * `notices.txt` in `dir` and the notices name it; when it cannot be saved, the log goes inline instead. Undefined when
 * the inline page already holds them all.
 */
export function savedNotices(state: ChildState, dir: string | undefined): ChildNotices | undefined {
	if (state.notices.more === 0) return undefined;
	const all = [...state.noticeLog.values()];
	try {
		if (!dir) throw new Error("no folder");
		const file = path.join(dir, NOTICES_FILE);
		writeScratchFile(file, `${all.map(noticeText).join("\n")}\n`);
		return { ...state.notices, file };
	} catch {
		return { ...state.notices, kept: all, more: 0 };
	}
}

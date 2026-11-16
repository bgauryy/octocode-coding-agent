import { redactSecrets } from "@octocodeai/octocode-common/sanitize";

/** A warning or error the child's extensions showed (`notify` with `notifyType` warning or error): the child has no screen, the parent keeps them. Whole, whatever its length. */
interface ChildNotice {
	level: "warning" | "error";
	text: string;
	/** How many times the child showed this exact notice (same level and text): repeats fold into one. */
	count: number;
}

/** `error: text`, or `warning (×3): text` for a notice shown three times. */
export const noticeText = (notice: ChildNotice): string =>
	`${notice.level}${notice.count > 1 ? ` (×${notice.count})` : ""}: ${notice.text}`;

/**
 * The inline page of a run's notices: the first distinct notices in the order they came, at most `NOTICES_INLINE` and
 * `NOTICES_INLINE_CHARS` characters of text. The page holds whole notices only; the rest are counted in
 * `ChildNotices.more` and kept in the run's saved log (`notices.txt`), within the log's bounds (`NoticeLog`).
 */
export const NOTICES_INLINE = 5;
export const NOTICES_INLINE_CHARS = 4_000;

/** How many distinct notices, and characters of their text, a run's log keeps, so a noisy child cannot grow the parent's memory without bound. */
const NOTICE_LOG_ENTRIES = 1_000;
export const NOTICE_LOG_CHARS = 1_000_000;

export interface ChildNotices {
	/** The inline page (see `NOTICES_INLINE`), counts included. */
	kept: ChildNotice[];
	/** Distinct notices that came after the inline page. */
	more: number;
	/** The latest error raised since the child's last model turn, whether or not it fits in `kept`: the reason an aborted child gives. A later turn means the child went on, so the error is not why it stopped. */
	lastError?: string;
	/** The file holding the run's notice log, one notice per line; set when the run ends with `more` above 0. */
	file?: string;
}

/**
 * Every distinct notice of a run, keyed by level and text, in the order they first came: the source of the saved log.
 * Repeats of a logged notice fold into it. Past `NOTICE_LOG_ENTRIES` or `NOTICE_LOG_CHARS`, a new notice is not kept:
 * one closing entry counts those (a repeat of one not kept counts again, as it cannot be recognised).
 */
export class NoticeLog {
	readonly #byKey = new Map<string, ChildNotice>();
	#chars = 0;
	#dropped: ChildNotice | undefined;

	/** Logs a notice: `notice` is set when it is new and kept, `repeat` when it folded into a logged one. */
	add(level: ChildNotice["level"], raw: string): { notice?: ChildNotice; repeat: boolean } {
		// A notice can quote a credential; it is kept (inline and in the saved log) only redacted.
		const text = redactSecrets(raw);
		const key = `${level}\u0000${text}`;
		const seen = this.#byKey.get(key);
		if (seen) {
			seen.count += 1;
			return { repeat: true };
		}
		if (this.#byKey.size >= NOTICE_LOG_ENTRIES || this.#chars + text.length > NOTICE_LOG_CHARS) {
			this.#dropped ??= {
				level: "warning",
				text: `notice not kept: the log holds the first ${NOTICE_LOG_ENTRIES} distinct notices or ${NOTICE_LOG_CHARS} characters`,
				count: 0,
			};
			this.#dropped.count += 1;
			return { repeat: false };
		}
		const notice: ChildNotice = { level, text, count: 1 };
		this.#byKey.set(key, notice);
		this.#chars += text.length;
		return { notice, repeat: false };
	}

	/** The logged notices in the order they came, then the count of those not kept. */
	values(): ChildNotice[] {
		return [...this.#byKey.values(), ...(this.#dropped ? [this.#dropped] : [])];
	}
}

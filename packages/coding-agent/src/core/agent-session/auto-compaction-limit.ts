/** How long automatic compaction stays off after a trip before one more attempt is let through. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
/** Failures in a row, for one session and model, that turn automatic compaction off. */
const LIMIT = 3;

/**
 * The guard on automatic compaction: three failures in a row for one session and model turn it off until a compaction
 * succeeds. Outages days apart are not three failures of one kind, so after a long interval one more attempt goes through;
 * when that fails too, the limit trips again at once.
 */
export class AutoCompactionLimit {
	#key = "";
	#count = 0;
	#lastFailureAt = 0;
	#noticed = false;

	/**
	 * Whether an attempt may run for `key`: "run", or else "notice" to say why not or "quiet" when that was already said.
	 * The threshold is checked on every turn, so its notice comes once per trip; an overflow's request has just failed and
	 * this is why it is not recovered, so it always says so.
	 */
	check(key: string, reason: "overflow" | "threshold"): "run" | "notice" | "quiet" {
		if (this.#key !== key) {
			this.succeeded();
			this.#key = key;
		}
		if (this.#count < LIMIT) return "run";
		if (Date.now() - this.#lastFailureAt >= RETRY_AFTER_MS) {
			this.#count = LIMIT - 1;
			this.#noticed = false;
			return "run";
		}
		if (reason === "threshold" && this.#noticed) return "quiet";
		this.#noticed = true;
		return "notice";
	}

	failed(): void {
		this.#count += 1;
		this.#lastFailureAt = Date.now();
	}

	succeeded(): void {
		this.#count = 0;
		this.#noticed = false;
	}
}

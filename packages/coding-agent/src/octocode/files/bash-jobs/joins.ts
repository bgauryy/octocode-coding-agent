import type { JobRow } from "../../../../../db/src/api.ts";
import { formatDuration } from "../../shared/format.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { firstLine } from "../../shared/util.ts";
import { ownerAlive } from "../../shared/job-standing.ts";
import type { JobLedger } from "./ledger.ts";

/** How often a joined job of another session is looked at. */
const POLL_MS = 2_000;

const key = (row: Pick<JobRow, "session_id" | "job">) => `${row.session_id}\u0000${row.job}`;

/**
 * Watches the running jobs of other sessions that this session joined, and calls `ended` once for each when it ends: its row
 * says so, or its owner is gone without recording it. The timer runs only while a job is watched and never keeps the
 * process alive; `stop` ends it.
 */
export class JoinWatch {
	private readonly watching = new Map<string, JobRow>();
	private timer: NodeJS.Timeout | undefined;

	private readonly ledger: JobLedger;
	private readonly ended: (row: JobRow, how: "ended" | "owner gone") => void;
	private readonly failed: (error: unknown) => void;
	private readonly pollMs: number;

	constructor(
		ledger: JobLedger,
		ended: (row: JobRow, how: "ended" | "owner gone") => void,
		failed: (error: unknown) => void,
		pollMs = POLL_MS,
	) {
		this.ledger = ledger;
		this.ended = ended;
		this.failed = failed;
		this.pollMs = pollMs;
	}

	watch(row: JobRow): void {
		this.watching.set(key(row), row);
		this.timer ??= setInterval(() => this.poll(), this.pollMs).unref();
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.watching.clear();
	}

	private poll(): void {
		try {
			for (const [id, row] of this.watching) {
				const now = this.ledger.current(row);
				if (now !== undefined && now.state === "running" && ownerAlive(now)) continue;
				this.watching.delete(id);
				this.ended(now ?? row, now === undefined || now.state === "running" ? "owner gone" : "ended");
			}
		} catch (error) {
			// A broken database stops the watch; the caller says so once instead of retrying it on every tick.
			this.stop();
			this.failed(error);
		}
		if (this.watching.size === 0) this.stop();
	}
}

/** `joined bash-4 (running 3m, log .octocode/tmp/check.log)`: what a second identical start is told. */
export function joinedText(row: JobRow, cwd: string, now: number): string {
	const who = [row.agent && `agent ${row.agent}`, row.item && `item ${row.item}`].filter(Boolean).join(", ");
	return `joined ${row.job} (running ${formatDuration(now - row.started_at)}, log ${shortPath(row.log, cwd)}); its exit wakes you.${who ? ` Started by ${who}.` : ""} Pass fresh: true to start a new run instead.`;
}

/** The message a joined job's end sends: the status header, then the `Background bash …` line the job renderer reads. */
export function joinedReport(row: JobRow, how: "ended" | "owner gone"): string {
	const status =
		how === "owner gone" || row.state === "stopped"
			? row.state === "stopped"
				? "stopped"
				: "owner gone"
			: row.exit_code === 0
				? "exit 0"
				: `exit ${row.exit_code ?? "?"}`;
	const seconds = Math.round(((row.ended_at ?? row.updated_at) - row.started_at) / 1000);
	const verdict =
		how === "owner gone"
			? "ended without recording how"
			: row.state === "stopped"
				? "was stopped"
				: row.exit_code === 0
					? "finished"
					: `failed with exit code ${row.exit_code ?? "?"}`;
	return `[${status} · ${seconds}s · log: ${shortPath(row.log, row.cwd)}]\nBackground bash ${row.job} ${verdict}: ${firstLine(row.command)}\nYou joined this job instead of starting it${row.agent ? `; it was started by ${row.agent}` : ""}. Read its output in the log.`;
}

import {
	formatProgramStatus,
	isProgramStatusReply,
	PROGRAM_STATUS_QUERY,
	type ProgramStatus,
} from "../program-status.ts";

/** Reports the program status (OSC 7501) to terminals that confirm they support it. */
export class ProgramStatusReporter {
	/** Latest program status, kept across stop() so start() can report it again. */
	private status?: ProgramStatus;
	/** Whether the terminal confirmed OSC 7501 support since the last start(), or `OCTOCODE_PROGRAM_STATUS=1`. */
	private supported = false;
	/** The support query was sent and its DA1 sentinel has not arrived yet. */
	private queryPending = false;

	/**
	 * Decide whether to ask the terminal about support, and return the query to send with the startup
	 * queries. The query shares their DA sentinel: a terminal that supports it replies before DA.
	 * `OCTOCODE_PROGRAM_STATUS=1` or `0` skips the query.
	 */
	beginQuery(): string {
		const override = process.env.OCTOCODE_PROGRAM_STATUS;
		this.supported = override === "1";
		this.queryPending = override !== "1" && override !== "0";
		return this.queryPending ? PROGRAM_STATUS_QUERY : "";
	}

	/** Take the support reply out of the input; returns whether `sequence` was one. */
	handleReply(sequence: string): boolean {
		if (!isProgramStatusReply(sequence)) return false;
		if (this.queryPending) {
			this.queryPending = false;
			this.supported = true;
			this.write();
		}
		return true;
	}

	/** The query's DA1 sentinel arrived without a reply first: the terminal does not support it. */
	settleQuery(): void {
		this.queryPending = false;
	}

	set(status: ProgramStatus): void {
		this.status = status.state === "clear" ? undefined : status;
		if (this.supported) process.stdout.write(formatProgramStatus(status));
	}

	/** Send the latest status again, for example when support is confirmed or the terminal restarts. */
	write(): void {
		if (this.supported && this.status) {
			process.stdout.write(formatProgramStatus(this.status));
		}
	}

	/** Remove the status while stopped, for example after exit or while suspended. start() reports it again. */
	stop(): void {
		if (this.supported && this.status) {
			process.stdout.write(formatProgramStatus({ state: "clear" }));
		}
		this.supported = false;
		this.queryPending = false;
	}
}

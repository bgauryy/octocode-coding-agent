import { reportToStderr } from "@octocodeai/octocode-common/stderr";

/** A failure handler for work no caller awaits or can act on: it goes to stderr, never the protocol stream. */
export function reportFailure(message: string): (error: unknown) => void {
	return (error) => reportToStderr(message, error);
}

/** Closes a session nobody awaits: a close that fails is reported, not dropped. */
export function closeInBackground(session: { close(): Promise<void> }): void {
	void session.close().catch(reportFailure("ACP session cleanup failed"));
}

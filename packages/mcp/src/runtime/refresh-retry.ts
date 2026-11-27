import type { McpClient, Tool as McpTool } from "../client/index.ts";

/** Waits before each retry of a failed `tools/list` refresh; its length is the number of retries. */
export const REFRESH_RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

/** One pending retry timer. `cancel()` is safe on every exit path: a newer refresh, a drop, a reconnect or close. */
export class RefreshRetry {
	private timer: ReturnType<typeof setTimeout> | undefined;

	/** Runs `run(attempt + 1)` after the delay for `attempt`; false when the retries are used up. */
	schedule(attempt: number, run: (attempt: number) => void): boolean {
		this.cancel();
		const delay = REFRESH_RETRY_DELAYS_MS[attempt];
		if (delay === undefined) return false;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			run(attempt + 1);
		}, delay);
		return true;
	}

	cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

/** The server's tools, or the error that kept them from being listed. */
export function listTools(client: McpClient): Promise<{ tools: McpTool[] } | { error: unknown }> {
	const listed = client.serverCapabilities?.tools ? client.listTools() : Promise.resolve([]);
	return listed.then(
		(tools) => ({ tools }),
		(error: unknown) => ({ error }),
	);
}

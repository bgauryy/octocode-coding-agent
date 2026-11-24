/**
 * The title a test worker shows in `ps` and Activity Monitor for its whole life. It does not start with the app's name,
 * which marks a session's own title (`team/store/place.ts`).
 */
export const TEST_WORKER_TITLE = "vitest-octocode-worker";

/**
 * Session tests set the title of the process they run in (`octocode-agent-main-<id>`): in a test worker that real title
 * would show the worker as a live Octocode session in `ps` and Activity Monitor, and each change costs a LaunchServices
 * call on macOS. The worker shows one fixed title instead, and `process.title` keeps what tests set in memory, which is
 * where every reader in this code takes it from. The real path stays tested in a child process (`processes/title.test.ts`).
 */
export function keepWorkerTitle(): void {
	process.title = TEST_WORKER_TITLE;
	let title = TEST_WORKER_TITLE;
	Object.defineProperty(process, "title", {
		configurable: true,
		enumerable: true,
		get: () => title,
		set: (value: unknown) => {
			title = String(value);
		},
	});
}

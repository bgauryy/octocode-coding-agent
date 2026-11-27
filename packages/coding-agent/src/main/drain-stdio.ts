/**
 * Wait until bytes queued on stdout and stderr have been handed to the OS, before an explicit `process.exit`.
 * Resolves early on a stream error and after `maxMs` when nobody reads the other end of a pipe.
 */
export function drainStdio(maxMs = 1000): Promise<void> {
	return new Promise((resolve) => {
		const streams = [process.stdout, process.stderr];
		let pending = streams.length;
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const stream of streams) stream.off("error", finish);
			resolve();
		};
		const timer = setTimeout(finish, maxMs);
		for (const stream of streams) {
			stream.on("error", finish);
			try {
				// An empty write's callback runs after every earlier write has been flushed.
				stream.write("", () => {
					if (--pending === 0) finish();
				});
			} catch {
				finish();
			}
		}
	});
}

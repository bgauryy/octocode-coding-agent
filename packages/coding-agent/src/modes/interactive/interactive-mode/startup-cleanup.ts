import fs from "node:fs";
import { inspect } from "node:util";

interface StartupCleanupHost {
	stop(): void;
	unregisterSignalHandlers(): void;
}

function reportCleanupFailure(message: string, error: unknown): void {
	try {
		const detail = error instanceof Error ? (error.stack ?? error.message) : inspect(error);
		fs.writeSync(2, `${message} ${detail}\n`);
	} catch {
		// Stderr may be gone; reporting must not replace the startup error or prevent cleanup.
	}
}

/** Roll back a partial startup before its caller receives the original failure. */
export async function withStartupCleanup(host: StartupCleanupHost, initialize: () => Promise<void>): Promise<void> {
	try {
		await initialize();
	} catch (error) {
		try {
			host.stop();
		} catch (cleanupError) {
			reportCleanupFailure("Octocode could not stop after startup failed:", cleanupError);
		} finally {
			// stop() may fail before reaching its listener cleanup.
			try {
				host.unregisterSignalHandlers();
			} catch (cleanupError) {
				reportCleanupFailure("Octocode could not remove startup handlers:", cleanupError);
			}
		}
		throw error;
	}
}

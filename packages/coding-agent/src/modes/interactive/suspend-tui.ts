import type { TUI } from "@octocodeai/octocode-tui";

/**
 * Suspends the TUI while a foreground child process (such as `$EDITOR` or a provider login CLI) owns the terminal.
 * In fullscreen mode, leaves the alternate screen with `preserveScreen: true` so the transcript is not dumped into
 * shell scrollback before the child runs.
 */
export async function suspendTuiForForegroundChild<T>(tui: TUI, run: () => Promise<T>): Promise<T> {
	tui.stop({ preserveScreen: tui.mode === "fullscreen" });
	try {
		await tui.terminal?.drainOutput?.();
		return await run();
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

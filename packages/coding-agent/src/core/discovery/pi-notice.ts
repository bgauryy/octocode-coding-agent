import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { type ContextView, piNoticeText } from "./context-view.ts";

/** The record that the one-time Pi notice was shown, in the agent directory next to the other per-user state. */
const NOTICE_FILE = "pi-notice.json";

const shownThisRun = new Map<string, string>();

/**
 * The one-line notice for the first startup that finds Pi items, naming what was found; undefined when nothing came from
 * Pi or the notice was shown on an earlier start. The first call records that it was shown. Later calls in the same process
 * return the same line, so a screen that is drawn again (a reload, a rebinding) keeps it instead of dropping it.
 */
export function takePiNotice(view: ContextView, agentDir: string): string | undefined {
	const kept = shownThisRun.get(agentDir);
	if (kept) return kept;
	const file = join(agentDir, NOTICE_FILE);
	if (existsSync(file)) return undefined;
	const text = piNoticeText(view);
	if (!text) return undefined;
	shownThisRun.set(agentDir, text);
	try {
		mkdirSync(dirname(file), { recursive: true });
		atomicWriteFileSync(file, `${JSON.stringify({ shownAt: new Date().toISOString() })}\n`);
	} catch {
		// A read-only agent directory cannot record it: the notice may show again, which is harmless.
	}
	return text;
}

/** Forget what this process showed (tests). */
export function resetPiNoticeForTests(): void {
	shownThisRun.clear();
}

import type { FeatureContext } from "../../core/features/index.ts";
import { notify } from "../shared/commands.ts";

/**
 * Shows a cleanup line from the deferred sweep: a failed or skipped pass as a warning, a finished one as an info notice.
 * Without a UI only problems reach stderr (a print-mode run stays quiet on success). The context may have been replaced
 * by the time the sweep finishes, which drops the notice rather than raising.
 */
export function reportSweep(ctx: Pick<FeatureContext, "hasUI" | "ui">, line: string): void {
	const problem = /\b(failed|skipped)\b/.test(line);
	try {
		if (ctx.hasUI) notify(ctx.ui, line, problem ? "warning" : "info");
		else if (problem) process.stderr.write(`${line}\n`);
	} catch {
		// The UI context was replaced after the session ended.
	}
}

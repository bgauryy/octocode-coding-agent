import { shortPath } from "../../utils/display-path.ts";

/** How much of a finished child's report the parent's message carries; the saved report holds the rest. */
const DIGEST_CHARS = 2_000;
const COORDINATOR_LINE = /^(?:For coordinator|Noticed|Ask user)\s*:/i;

/**
 * A child report as the parent's message carries it. A report whose full text is saved (`file`) and runs past the
 * digest keeps its head, any trailing coordinator metadata lines (`For coordinator:`, `Noticed:`, `Ask user:`) and its
 * pointer line, so a burst of reports costs the parent a screen each without losing actionable handoff signals.
 */
export function reportDigest(text: string, file: string | undefined): string {
	if (!file || text.length <= DIGEST_CHARS) return text;
	const lines = text.split("\n");
	const pointer = lines.at(-1)?.includes(shortPath(file)) ? lines.pop() : undefined;
	if (!pointer) return text;
	const preserved: string[] = [];
	while (lines.length > 1) {
		const last = lines.at(-1)!.trim();
		if (!last) {
			lines.pop();
			continue;
		}
		if (!COORDINATOR_LINE.test(last)) break;
		preserved.unshift(lines.pop()!);
	}
	const tailSuffix = preserved.length > 0 ? `\n${preserved.join("\n")}` : "";
	const body = `${lines.join("\n")}${tailSuffix}`;
	if (body.length <= DIGEST_CHARS) return text;
	const headBudget = Math.max(200, DIGEST_CHARS - tailSuffix.length - pointer.length - 36);
	const remaining = lines.join("\n");
	if (remaining.length <= headBudget) return `${remaining}${tailSuffix}\n${pointer}`;
	const cut = remaining.lastIndexOf("\n", headBudget);
	const head = remaining.slice(0, cut > headBudget / 2 ? cut : headBudget);
	return `${head}\n[+${remaining.length - head.length} characters cut]${tailSuffix}\n${pointer}`;
}

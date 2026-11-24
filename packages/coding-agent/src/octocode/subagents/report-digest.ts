import { shortPath } from "../../utils/display-path.ts";

/** How much of a finished child's report the parent's message carries; the saved report holds the rest. */
const DIGEST_CHARS = 2_000;

/**
 * A child report as the parent's message carries it. A report whose full text is saved (`file`) and runs past the
 * digest keeps its head and its pointer line (the outcome sits in the message header), so a burst of reports costs the
 * parent a screen each, not their whole text; the model reads the file for the rest. A short report, one without a saved
 * file or a pointer to it travels whole.
 */
export function reportDigest(text: string, file: string | undefined): string {
	if (!file || text.length <= DIGEST_CHARS) return text;
	const lines = text.split("\n");
	const pointer = lines.at(-1)?.includes(shortPath(file)) ? lines.pop() : undefined;
	if (!pointer) return text;
	const body = lines.join("\n");
	if (body.length <= DIGEST_CHARS) return text;
	const cut = body.lastIndexOf("\n", DIGEST_CHARS);
	const head = body.slice(0, cut > DIGEST_CHARS / 2 ? cut : DIGEST_CHARS);
	return `${head}\n[+${body.length - head.length} characters cut]\n${pointer}`;
}

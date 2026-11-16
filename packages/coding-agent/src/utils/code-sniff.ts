import { isJsonDocument } from "@octocodeai/octocode-common/json-color";

/** A hunk head (`@@ -1,2 +1,3 @@`), a git file head, or the `---`/`+++` pair that opens a file's changes. */
const UNIFIED_DIFF = /^(?:@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|diff --git \S+ \S+|--- \S.*\n\+\+\+ \S)/m;

/** Whether `text` is a unified diff (what `git diff` prints): a numbered `-1 old` listing and a plain `- item` list are not. */
export function isUnifiedDiff(text: string): boolean {
	return UNIFIED_DIFF.test(text);
}

/** The language of a block that names none, when its shape settles it: one JSON document, or a unified diff. */
export function guessLanguage(code: string): "json" | "diff" | undefined {
	if (isJsonDocument(code)) return "json";
	return isUnifiedDiff(code) ? "diff" : undefined;
}

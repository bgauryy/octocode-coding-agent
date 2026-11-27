import { sha256 } from "@octocodeai/octocode-common/atomic-file";

/**
 * `sha256-<base64>` of a web page's one inline script. The page has exactly one script without attributes (the data block
 * has a type, and its JSON escapes every `<`); the script's text ends at the first `</script>`. It imports
 * nothing from the webview package, so headless code can hash a page without loading it.
 */
export function inlineScriptHash(html: string): string {
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (script === undefined) throw new Error("The web page has no inline script.");
	return `sha256-${Buffer.from(sha256(script, "base64url"), "base64url").toString("base64")}`;
}

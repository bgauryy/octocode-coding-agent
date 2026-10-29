import { renderDaemonHtml } from "@octocodeai/octocode-webview";
import { VERSION } from "../../config.ts";
import { sha256 } from "../../utils/atomic-file.ts";

export interface DaemonPage {
	html: string;
	/** `sha256-<base64>` of the page's one inline script, for the Content-Security-Policy header. */
	scriptHash: string;
	/** Package version plus a hash of the page: a launcher of another build drains this daemon. */
	build: string;
}

let cached: DaemonPage | undefined;

export function daemonPage(): DaemonPage {
	if (cached) return cached;
	const html = renderDaemonHtml();
	// The page has exactly one script without attributes (the data block has a type); its text ends at the first `</script>`.
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (script === undefined) throw new Error("The daemon page has no inline script.");
	cached = {
		html,
		scriptHash: `sha256-${Buffer.from(sha256(script, "base64url"), "base64url").toString("base64")}`,
		build: `${VERSION}:${sha256(html).slice(0, 12)}`,
	};
	return cached;
}

import { renderDaemonHtml } from "@octocodeai/octocode-webview";
import { VERSION } from "../../config.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { inlineScriptHash } from "../workspace/inline-script-hash.ts";

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
	cached = {
		html,
		scriptHash: inlineScriptHash(html),
		build: `${VERSION}:${sha256(html).slice(0, 12)}`,
	};
	return cached;
}

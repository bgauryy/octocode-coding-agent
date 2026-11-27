import { renderDaemonHtml } from "@octocodeai/octocode-webview";
import { getPackageDir, VERSION } from "../../config.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { inlineScriptHash } from "../workspace/inline-script-hash.ts";

export interface DaemonPage {
	html: string;
	/** `sha256-<base64>` of the page's one inline script, for the Content-Security-Policy header. */
	scriptHash: string;
	/**
	 * `<package version>:<page hash>:<install hash>`. The install hash names the package directory, so a launcher can tell
	 * its own install's older page (drain it) from another install of the same version (leave it).
	 */
	build: string;
}

let cached: DaemonPage | undefined;

export function daemonPage(): DaemonPage {
	if (cached) return cached;
	const html = renderDaemonHtml();
	cached = {
		html,
		scriptHash: inlineScriptHash(html),
		build: `${VERSION}:${sha256(html).slice(0, 12)}:${sha256(getPackageDir()).slice(0, 8)}`,
	};
	return cached;
}

export interface PagePolicyOptions {
	/**
	 * The `script-src` sources. The meta tag allows the page's own inline script with `'unsafe-inline'`; a header names
	 * hashes, which disable `'unsafe-inline'`, so it must list every inline script the page runs.
	 */
	scripts: readonly string[];
	/**
	 * A live page talks to its own host and previews attachments (images, audio, video) from `blob:` URLs it creates
	 * from bytes it fetched; the offline export does neither.
	 */
	live: boolean;
	/** A header may forbid framing; a meta tag cannot (browsers ignore `frame-ancestors` there). */
	header?: boolean;
}

/**
 * The Content-Security-Policy of the backlog and workspace pages, for both their meta tag and the daemon's header, so
 * the two cannot drift apart. A page served with both must satisfy both. Nothing loads from the network: images are
 * `data:` or page-made `blob:` URLs, media only page-made `blob:` URLs, and connections go only to the page's host.
 */
export function pagePolicy({ scripts, live, header = false }: PagePolicyOptions): string {
	return [
		"default-src 'none'",
		`script-src ${scripts.join(" ")}`,
		"style-src 'unsafe-inline'",
		live ? "img-src data: blob:" : "img-src data:",
		// The notification service worker is a script the host serves from its own origin.
		...(live ? ["media-src blob:", "connect-src 'self'", "worker-src 'self'"] : []),
		"base-uri 'none'",
		"form-action 'none'",
		...(header ? ["frame-ancestors 'none'"] : []),
	].join("; ");
}

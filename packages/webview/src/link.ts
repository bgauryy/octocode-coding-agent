/**
 * The one policy for a link the page makes navigable, from Markdown, a citation or the host (sign-in and key pages):
 * an absolute http(s) address without credentials, returned normalized. Anything else stays text.
 */
export function safeWebLink(value: string): string | null {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

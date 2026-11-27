import type { RemoteLink, RemoteStatus } from "@octocodeai/octocode-contracts/daemon";
import { qrText } from "@octocodeai/octocode-common/qr";

/** What a link lets its holder do, said once wherever the link is shown. */
function accessNote(link: Pick<RemoteLink, "access">): string {
	return link.access === "control"
		? "Anyone with this link can send commands and answer approvals in your sessions."
		: "Anyone with this link can read every session on this machine (transcripts included), the board, reports and provider configuration; nothing can be sent through it.";
}

/**
 * The capability a link carries after `#`: the control or view token of an `ssh` link (`#access=`), the key of a `relay`
 * link (`#k=`). A session registers it as a secret before it shows the link, so only the terminal shows it: every
 * redacted copy, including the notice the session's pages and the devices following it receive, reads `[redacted]`.
 */
export function linkSecret(link: Pick<RemoteLink, "url">): string | undefined {
	try {
		const fragment = new URLSearchParams(new URL(link.url).hash.slice(1));
		return fragment.get("access") ?? fragment.get("k") ?? undefined;
	} catch {
		// Not a URL: nothing to register, and nothing the page could open either.
		return undefined;
	}
}

/** The lines to print for a freshly published link: how to reach it, the link, what it allows, and a QR code. */
export function describeLink(link: RemoteLink, options: { qr?: boolean } = {}): string {
	const lines: string[] = [];
	if (link.transport === "ssh") {
		lines.push(`On the other device, run this first and keep it running:\n  ${link.forward ?? ""}`.trimEnd());
		lines.push(`Then open: ${link.url}`);
	} else {
		lines.push(`Open on the other device: ${link.url}`);
		lines.push("The relay forwards sealed frames; the key after # stays in the link and never reaches the relay.");
	}
	lines.push(`${accessNote(link)} Stop with /remote stop.`);
	if (options.qr) lines.push(qrText(link.url));
	return lines.join("\n");
}

/** The lines for `/remote status`. */
export function describeStatus(status: RemoteStatus): string {
	if (status.links.length === 0 && !status.relay) return "Nothing is published. Run /remote or /remote view.";
	const lines = status.links.map(
		(link) =>
			`${link.access} link over ${link.transport}, issued ${new Date(link.issuedAt).toLocaleTimeString()}, id ${link.fingerprint}`,
	);
	if (status.relay)
		lines.push(
			`Relay ${status.relay.url}: ${status.relay.state}, ${status.relay.peers} device${status.relay.peers === 1 ? "" : "s"} connected${status.relay.error ? ` (${status.relay.error})` : ""}.`,
		);
	return lines.join("\n");
}

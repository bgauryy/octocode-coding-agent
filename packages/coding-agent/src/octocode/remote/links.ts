import type { RemoteLink, RemoteStatus } from "@octocodeai/octocode-contacts/daemon";
import { qrText } from "./qr.ts";

/** What a link lets its holder do, said once wherever the link is shown. */
export function accessNote(link: Pick<RemoteLink, "access">): string {
	return link.access === "control"
		? "Anyone with this link can send commands and answer approvals in your sessions."
		: "This link only shows your sessions; nothing can be sent through it.";
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
			`${link.access} link over ${link.transport}, issued ${new Date(link.issuedAt).toLocaleTimeString()}: ${link.url}`,
	);
	if (status.relay)
		lines.push(
			`Relay ${status.relay.url}: ${status.relay.state}, ${status.relay.peers} device${status.relay.peers === 1 ? "" : "s"} connected${status.relay.error ? ` (${status.relay.error})` : ""}.`,
		);
	return lines.join("\n");
}

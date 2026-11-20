import fs from "node:fs";
import path from "node:path";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext } from "../../core/features/index.ts";
import { BranchIndex } from "../shared/branch-index.ts";
import { INTERNAL_MESSAGE_TYPE } from "../shared/messages.ts";
import {
	type AttachmentReference,
	attachmentFileName,
	attachmentReferences,
	attachmentTextProblem,
	MAX_ATTACHMENT_BYTES,
} from "./attachment.ts";

/**
 * The bytes a teammate attached (`attachment.ts`), as the file tool's `fromAttachment` writes them: only an attachment
 * that team mail delivered to this session, and only while its saved copy still holds the bytes its SHA-256 names. The
 * composition root hands `attachmentContent` to the file tool, which may not import team.
 */

/** The attachments team mail put in this session's branch, by SHA-256 (the last reference wins). */
const delivered = new BranchIndex<Map<string, AttachmentReference>>(
	() => new Map(),
	(state, entry) => {
		if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== INTERNAL_MESSAGE_TYPE) return;
		const mail = isRecord(entry.details) ? entry.details.messages : undefined;
		if (!Array.isArray(mail)) return;
		for (const message of mail)
			if (isRecord(message) && typeof message.text === "string")
				for (const reference of attachmentReferences(message.text)) state.set(reference.sha256, reference);
	},
);

const SHA256 = /^[0-9a-f]{64}$/;

/** An attachment that cannot be written as sent: not delivered, its copy gone, changed, a link, or no text. */
class AttachmentUnavailable extends Error {}

/** The saved bytes of `reference`, read without following a link; undefined when the file is gone. */
function savedBytes(reference: AttachmentReference): Buffer | undefined {
	let fd: number;
	try {
		fd = fs.openSync(reference.saved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		// A link where the copy was saved: what it points at was never checked by the sender.
		if (code === "ELOOP")
			throw new AttachmentUnavailable(`${reference.saved} is a link, not a saved attachment.`, { cause: error });
		throw error;
	}
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
			throw new AttachmentUnavailable(`${reference.saved} is not a saved attachment.`);
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/** The text of the attachment `hash` delivered to this session, checked against its hash. Throws naming what to do. */
export function attachmentContent(hash: string, ctx: Pick<FeatureContext, "sessionManager">): string {
	const wanted = hash.trim().toLowerCase();
	if (!SHA256.test(wanted))
		throw new AttachmentUnavailable(
			`fromAttachment takes the 64-character sha256 of an <attachment> reference, not "${hash}".`,
		);
	const reference = delivered.read(ctx.sessionManager).get(wanted);
	if (!reference)
		throw new AttachmentUnavailable(
			`No attachment with sha256 ${wanted} reached this session: fromAttachment takes the sha256 of an <attachment> reference in a message you received.`,
		);
	return checkedText(reference);
}

/**
 * The attachments a mail `text` references, each with its checked text, or none when its saved copy cannot be read back
 * as sent, for the provenance index (`permission/provenance/reports.ts`). A failure other than those still throws.
 */
export function attachmentTexts(text: string): Array<{ sha256: string; path: string; text?: string }> {
	return attachmentReferences(text).map((reference) => {
		const named = { sha256: reference.sha256.toLowerCase(), path: reference.path };
		try {
			return { ...named, text: checkedText(reference) };
		} catch (error) {
			if (error instanceof AttachmentUnavailable) return named;
			throw error;
		}
	});
}

/** The saved copy of `reference` as text, when it still holds the bytes its hash names. */
function checkedText(reference: AttachmentReference): string {
	const hash = reference.sha256.toLowerCase();
	const resend = `Ask its sender to send it again; nothing was written.`;
	if (!path.isAbsolute(reference.saved) || path.basename(reference.saved) !== attachmentFileName(hash))
		throw new AttachmentUnavailable(`The attachment ${reference.path} names no saved copy of its own. ${resend}`);
	const bytes = savedBytes(reference);
	if (!bytes) throw new AttachmentUnavailable(`The saved copy of the attachment ${reference.path} is gone. ${resend}`);
	if (bytes.length !== reference.bytes || sha256(bytes) !== hash)
		throw new AttachmentUnavailable(
			`The saved copy of the attachment ${reference.path} changed since it was sent. ${resend}`,
		);
	const problem = attachmentTextProblem(reference.path, bytes);
	if (problem) throw new AttachmentUnavailable(`${problem} Nothing was written.`);
	return bytes.toString("utf8");
}

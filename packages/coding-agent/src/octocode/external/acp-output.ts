import { appendFileSync } from "node:fs";
import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { PRIVATE_FILE_MODE } from "../shared/home.ts";
import { redactSecrets } from "../shared/sanitize.ts";
import { saveTimestamped } from "../shared/spill.ts";
import { cutText } from "../shared/util.ts";
import type { ExternalReply } from "./protocol.ts";

const MAX_UPDATES_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** Overflow evidence uses the existing private session output directory and its cleanup lifecycle. */
class AcpArchive {
	private readonly file: string | undefined;
	private bytes = 0;
	private omittedBytes = 0;
	private failure: string | undefined;

	constructor(label: string, extension: string) {
		this.file = saveTimestamped("", label, extension);
		if (!this.file) this.failure = "Output archive could not be saved.";
	}

	append(text: string): void {
		const redacted = redactSecrets(text);
		const size = Buffer.byteLength(redacted);
		if (!this.failure && this.bytes + size > MAX_ARCHIVE_BYTES)
			this.failure = "Output archive reached its 32 MiB limit.";
		if (!this.failure && this.file) {
			try {
				appendFileSync(this.file, redacted, { mode: PRIVATE_FILE_MODE });
				this.bytes += size;
				return;
			} catch {
				this.failure = "Output archive could not be completed.";
			}
		}
		this.omittedBytes += size;
	}

	get metadata() {
		return {
			type: "output_truncated",
			...(this.file ? { file: this.file } : {}),
			archiveComplete: !this.failure,
			archiveBytes: this.bytes,
			omittedBytes: this.omittedBytes,
			...(this.failure ? { error: this.failure } : {}),
		};
	}

	get note(): string {
		return `[ACP output truncated. ${this.file ? `Redacted archive: ${this.file}. ` : ""}${this.failure ?? "Full retained evidence is in the archive."}]`;
	}
}

/** Retain the latest diagnostics, with explicit evidence and failure markers once the connection exceeds 64 KiB. */
export class AcpDiagnostics {
	private preview = "";
	private archive?: AcpArchive;

	append(text: string): void {
		if (!this.archive && Buffer.byteLength(this.preview) + Buffer.byteLength(text) > MAX_TEXT_BYTES) {
			this.archive = new AcpArchive("acp-stderr", "txt");
			this.archive.append(this.preview);
		}
		this.archive?.append(text);
		this.preview = cutText(this.preview + text, MAX_TEXT_BYTES, { tail: true });
	}

	toString(): string {
		return this.archive ? `${this.archive.note}\n${this.preview}` : this.preview;
	}
}

/** Bound each turn while preserving small replies, the final answer tail, and every terminal outcome. */
export class AcpOutput {
	private readonly updates: SessionNotification[] = [];
	private bytes = 0;
	private text = "";
	private textTruncated = false;
	private archive?: AcpArchive;

	append(notification: SessionNotification): void {
		const serialized = JSON.stringify(notification);
		const size = Buffer.byteLength(serialized);
		const update = notification.update;
		if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
			this.textTruncated ||= Buffer.byteLength(this.text) + Buffer.byteLength(update.content.text) > MAX_TEXT_BYTES;
			this.text = cutText(this.text + update.content.text, MAX_TEXT_BYTES, { tail: true });
		}
		if (!this.archive && (this.bytes + size > MAX_UPDATES_BYTES || this.textTruncated)) this.spill();
		if (this.archive) {
			this.archive.append(`${serialized}\n`);
			return;
		}
		this.bytes += size;
		const last = this.updates.at(-1);
		if (
			last?.update.sessionUpdate === "agent_message_chunk" &&
			last.update.content.type === "text" &&
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text" &&
			withoutText(last) === withoutText(notification)
		) {
			last.update.content.text += update.content.text;
		} else this.updates.push(structuredClone(notification));
	}

	reply(response?: PromptResponse): ExternalReply {
		const terminal = response ? { type: "prompt_response", response } : undefined;
		if (terminal) {
			const serialized = JSON.stringify(terminal);
			if (!this.archive && this.bytes + Buffer.byteLength(serialized) > MAX_UPDATES_BYTES) this.spill();
			this.archive?.append(`${serialized}\n`);
		}
		return {
			text: this.archive ? `${this.text}${this.text ? "\n" : ""}${this.archive.note}` : this.text,
			...(response ? { stopReason: response.stopReason } : {}),
			updates: [
				...this.updates,
				...(this.archive ? [this.archive.metadata] : []),
				...(terminal
					? [
							this.archive
								? { type: "prompt_response", response: { stopReason: terminal.response.stopReason } }
								: terminal,
						]
					: []),
			],
		};
	}

	private spill(): void {
		this.archive = new AcpArchive("acp-output", "jsonl");
		for (const update of this.updates) this.archive.append(`${JSON.stringify(update)}\n`);
	}
}

/** Metadata and annotations must agree before adjacent textual notifications can merge. */
function withoutText(notification: SessionNotification): string {
	const { update } = notification;
	return JSON.stringify(
		update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
			? { ...notification, update: { ...update, content: { ...update.content, text: "" } } }
			: notification,
	);
}

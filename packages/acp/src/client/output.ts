import { appendFileSync } from "node:fs";
import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { PRIVATE_FILE_MODE } from "../../../coding-agent/src/octocode/shared/home.ts";
import { redactData, redactSecrets } from "../../../coding-agent/src/octocode/shared/sanitize.ts";
import { saveTimestamped } from "../../../coding-agent/src/octocode/shared/spill.ts";
import {
	ACP_TEXT_BYTES,
	ACP_TEXT_POINTER,
	ACP_TEXT_STREAMS,
	ACP_STREAM_KEY_BYTES,
	AcpAnswerPreview,
	AcpTextRedactor,
	redactedUpdates,
	textStreamKey,
	textUpdate,
} from "./redaction.ts";
import type { ExternalReply } from "../../../coding-agent/src/octocode/external/protocol.ts";

const MAX_UPDATES_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

type RedactionStatus = {
	bufferedBytes: number;
	redactionOmittedBytes: number;
	captureIncomplete?: boolean;
	untrackedStreamBytes?: number;
};

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

	appendRedacted(text: string): void {
		const size = Buffer.byteLength(text);
		if (!this.failure && this.bytes + size > MAX_ARCHIVE_BYTES)
			this.failure = "Output archive reached its 32 MiB limit.";
		if (!this.failure && this.file) {
			try {
				appendFileSync(this.file, text, { mode: PRIVATE_FILE_MODE });
				this.bytes += size;
				return;
			} catch {
				this.failure = "Output archive could not be completed.";
			}
		}
		this.omittedBytes += size;
	}

	appendRecord(record: unknown): void {
		const serialized = JSON.stringify(record, (_key, value: unknown) => {
			if (typeof value === "string") return redactSecrets(value);
			if (value && typeof value === "object" && !Array.isArray(value)) {
				return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactSecrets(key), entry]));
			}
			return value;
		});
		this.appendRedacted(`${serialized}\n`);
	}

	metadata(status: RedactionStatus) {
		return {
			type: "output_truncated",
			...(this.file ? { file: this.file } : {}),
			archiveComplete:
				!this.failure && !status.bufferedBytes && !status.redactionOmittedBytes && !status.captureIncomplete,
			archiveBytes: this.bytes,
			omittedBytes: this.omittedBytes,
			...status,
			...(this.failure ? { error: this.failure } : {}),
		};
	}

	note(status: RedactionStatus): string {
		const redaction = [
			...(status.captureIncomplete ? ["Capture ended before a terminal response."] : []),
			...(status.bufferedBytes ? [`${status.bufferedBytes} unfinished text bytes are buffered, not archived.`] : []),
			...(status.redactionOmittedBytes
				? [`${status.redactionOmittedBytes} text bytes were omitted to keep stream redaction bounded.`]
				: []),
			...(status.untrackedStreamBytes
				? [`Text stream identities are limited to ${ACP_TEXT_STREAMS} streams of ${ACP_STREAM_KEY_BYTES} bytes each.`]
				: []),
		].join(" ");
		return `[ACP output truncated. ${this.file ? `Redacted archive: ${this.file}. ` : ""}${this.failure ?? (redaction || "Full retained evidence is in the archive.")}${this.failure && redaction ? ` ${redaction}` : ""}]`;
	}
}

/** Retain the latest diagnostics, with explicit evidence and failure markers once the connection exceeds 64 KiB. */
export class AcpDiagnostics {
	private readonly text = new AcpTextRedactor((text) => this.archive?.appendRedacted(text));
	private bytes = 0;
	private archive?: AcpArchive;

	append(text: string): void {
		this.bytes += Buffer.byteLength(text);
		if (!this.archive && this.bytes > ACP_TEXT_BYTES) {
			this.archive = new AcpArchive("acp-stderr", "txt");
			// The preview can include an unfinished unit; only previously emitted text is safe to archive.
			this.archive.appendRedacted(this.text.completedPreview());
		}
		this.text.append(text);
	}

	toString(): string {
		const status = { bufferedBytes: this.text.bufferedBytes, redactionOmittedBytes: this.text.omittedBytes };
		return this.archive ? `${this.archive.note(status)}\n${this.text.preview()}` : this.text.preview();
	}
}

/** Bound each turn while preserving small replies, the final answer tail, and every terminal outcome. */
export class AcpOutput {
	private readonly updates: SessionNotification[] = [];
	private bytes = 0;
	private readonly text = new AcpAnswerPreview();
	private archive?: AcpArchive;
	private readonly streams = new Map<string, AcpTextRedactor>();
	private excessStreamBytes = 0;
	private completedStreamOmissions = 0;
	private result?: ExternalReply;

	append(notification: SessionNotification): void {
		if (this.result) return;
		const serialized = JSON.stringify(notification);
		const size = Buffer.byteLength(serialized);
		const update = notification.update;
		this.text.append(notification);
		if (!this.archive && (this.bytes + size > MAX_UPDATES_BYTES || this.text.bytes > ACP_TEXT_BYTES)) this.spill();
		if (this.archive) {
			this.archiveNotification(notification);
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
		if (this.result) return this.result;
		const text = this.text.finish();
		const terminal = response ? { type: "prompt_response", response } : undefined;
		if (terminal) {
			const serialized = JSON.stringify(terminal);
			if (!this.archive && this.bytes + Buffer.byteLength(serialized) > MAX_UPDATES_BYTES) this.spill();
		}
		for (const stream of this.streams.values()) stream.finish();
		if (terminal) this.archive?.appendRecord(terminal);
		const status = this.redactionStatus(!response);
		this.result = {
			text: this.archive ? `${text}${text ? "\n" : ""}${this.archive.note(status)}` : text,
			...(response ? { stopReason: response.stopReason } : {}),
			updates: [
				...redactedUpdates(this.updates, !!this.archive),
				...(this.archive ? [this.archive.metadata(status)] : []),
				...(terminal
					? [
							this.archive
								? { type: "prompt_response", response: { stopReason: terminal.response.stopReason } }
								: redactData(terminal),
						]
					: []),
			],
		};
		return this.result;
	}

	private spill(): void {
		this.archive = new AcpArchive("acp-output", "jsonl");
		for (const update of this.updates) this.archiveNotification(update);
	}

	private archiveNotification(notification: SessionNotification): void {
		const update = textUpdate(notification);
		if (!update) {
			this.archive!.appendRecord(notification);
			return;
		}
		const key = textStreamKey(notification);
		this.archive!.appendRecord({
			...notification,
			update: { ...update, content: { ...update.content, text: ACP_TEXT_POINTER } },
		});
		let stream = this.streams.get(key);
		if (!stream && this.streams.size === ACP_TEXT_STREAMS) {
			const idle = [...this.streams].find(([, candidate]) => candidate.idle);
			if (idle) {
				this.completedStreamOmissions += idle[1].omittedBytes;
				this.streams.delete(idle[0]);
			}
		}
		if (!stream && this.streams.size < ACP_TEXT_STREAMS && Buffer.byteLength(key) <= ACP_STREAM_KEY_BYTES) {
			stream = new AcpTextRedactor(
				(text) => this.archive!.appendRecord({ type: "text_stream", stream: key, text }),
				false,
			);
			this.streams.set(key, stream);
		}
		if (stream) stream.append(update.content.text);
		else this.excessStreamBytes += Buffer.byteLength(update.content.text);
	}

	private redactionStatus(captureIncomplete: boolean): RedactionStatus {
		let bufferedBytes = 0;
		let redactionOmittedBytes = this.excessStreamBytes + this.completedStreamOmissions;
		for (const stream of this.streams.values()) {
			bufferedBytes += stream.bufferedBytes;
			redactionOmittedBytes += stream.omittedBytes;
		}
		return { bufferedBytes, redactionOmittedBytes, captureIncomplete, untrackedStreamBytes: this.excessStreamBytes };
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

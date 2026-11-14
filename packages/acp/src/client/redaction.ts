import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
	redactData,
	redactSecretFragments,
	redactSecrets,
	secretContinuesAfterLine,
	unfinishedPrivateKey,
} from "@octocodeai/octocode-common/sanitize";
import { cutText } from "@octocodeai/octocode-common/text";

export const ACP_TEXT_BYTES = 64 * 1024;
export const ACP_TEXT_POINTER = "[ACP text is captured in redacted text_stream records.]";
export const ACP_TEXT_STREAMS = 8;
export const ACP_STREAM_KEY_BYTES = 1024;
const OMITTED_TEXT = "[ACP text omitted: unfinished redaction unit exceeded 64 KiB.]";

/** Hold unfinished lines before writing; oversized units are omitted through the next safe line boundary. */
export class AcpTextRedactor {
	private pending = "";
	private boundary = "";
	private dropping = false;
	private privateKeyEnd: string | undefined;
	private privateKeyTail = "";
	private possiblePrivateKey = false;
	private tail = "";
	private readonly emit: (text: string) => void;
	private readonly retainPreview: boolean;
	bufferedBytes = 0;
	omittedBytes = 0;

	constructor(emit: (text: string) => void = () => {}, retainPreview = true) {
		this.emit = emit;
		this.retainPreview = retainPreview;
	}

	append(text: string): void {
		let start = 0;
		while (start < text.length) {
			const newline = text.indexOf("\n", start);
			const end = newline === -1 ? text.length : newline + 1;
			const part = text.slice(start, end);
			const bytes = Buffer.byteLength(part);
			this.trackPrivateKey(part);
			// Whitespace can continue an introducer indefinitely; compress it before keeping the bounded suffix.
			this.boundary = (this.boundary + part).replace(/\s+/gu, " ").slice(-64);
			if (this.dropping) this.omittedBytes += bytes;
			else if (this.bufferedBytes + bytes > ACP_TEXT_BYTES) {
				if (this.privateKeyEnd === undefined && this.possiblePrivateKey) this.privateKeyEnd = "";
				this.omittedBytes += this.bufferedBytes + bytes;
				this.pending = "";
				this.bufferedBytes = 0;
				this.dropping = true;
				this.write(OMITTED_TEXT);
			} else {
				this.pending += part;
				this.bufferedBytes += bytes;
			}
			if (newline !== -1 && this.privateKeyEnd === undefined && !secretContinuesAfterLine(this.boundary)) {
				if (this.dropping) this.write("\n");
				else this.write(redactSecrets(this.pending));
				this.clear();
			}
			start = end;
		}
	}

	finish(): void {
		if (!this.dropping && this.pending) this.write(redactSecrets(this.pending));
		this.clear();
	}

	preview(): string {
		return cutText(this.tail + redactSecrets(this.pending), ACP_TEXT_BYTES, { tail: true });
	}

	completedPreview(): string {
		return this.tail;
	}

	get idle(): boolean {
		return !this.pending && !this.dropping && this.privateKeyEnd === undefined;
	}

	private trackPrivateKey(part: string): void {
		if (!this.dropping) {
			const text = this.pending + part;
			this.privateKeyEnd = unfinishedPrivateKey(text);
			this.possiblePrivateKey = text.lastIndexOf("-----BEGIN ") > text.lastIndexOf("-----END ");
			this.privateKeyTail = text.slice(-300);
		} else if (this.privateKeyEnd !== "") {
			let text = this.privateKeyTail + part;
			if (this.privateKeyEnd) {
				const end = text.indexOf(this.privateKeyEnd);
				if (end !== -1) {
					text = text.slice(end + this.privateKeyEnd.length);
					this.privateKeyEnd = undefined;
					this.possiblePrivateKey = false;
				}
			}
			if (this.privateKeyEnd === undefined) {
				this.privateKeyEnd = unfinishedPrivateKey(text);
				this.possiblePrivateKey ||= text.lastIndexOf("-----BEGIN ") > text.lastIndexOf("-----END ");
				if (part.endsWith("\n") && this.privateKeyEnd === undefined && this.possiblePrivateKey) this.privateKeyEnd = "";
			}
			this.privateKeyTail = text.slice(-300);
		}
	}

	private write(text: string): void {
		if (this.retainPreview) this.tail = cutText(this.tail + text, ACP_TEXT_BYTES, { tail: true });
		this.emit(text);
	}

	private clear(): void {
		this.pending = "";
		this.boundary = "";
		this.bufferedBytes = 0;
		this.dropping = false;
		this.privateKeyEnd = undefined;
		this.privateKeyTail = "";
		this.possiblePrivateKey = false;
	}
}

/** Coherent logical messages in first-seen order; raw notification updates retain chunk arrival order. */
export class AcpAnswerPreview {
	private readonly streams = new Map<string, { redactor: AcpTextRedactor; slot: { text: string; active: boolean } }>();
	private readonly slots: Array<{ text: string; active: boolean }> = [];
	private omitted = false;
	bytes = 0;

	append(notification: SessionNotification): void {
		const update = textUpdate(notification);
		if (!update || update.sessionUpdate !== "agent_message_chunk") return;
		this.bytes += Buffer.byteLength(update.content.text);
		const key = textStreamKey(notification);
		let stream = this.streams.get(key);
		if (!stream && this.streams.size === ACP_TEXT_STREAMS) {
			const idle = [...this.streams].find(([, candidate]) => candidate.redactor.idle);
			if (idle) {
				idle[1].slot.text = idle[1].redactor.preview();
				idle[1].slot.active = false;
				this.streams.delete(idle[0]);
				this.compact();
			}
		}
		if (!stream && this.streams.size < ACP_TEXT_STREAMS && Buffer.byteLength(key) <= ACP_STREAM_KEY_BYTES) {
			const slot = { text: "", active: true };
			this.slots.push(slot);
			stream = { redactor: new AcpTextRedactor(), slot };
			this.streams.set(key, stream);
		}
		if (stream) stream.redactor.append(update.content.text);
		else this.omitted = true;
	}

	/** At most one retired span between active streams; each span retains only the bounded answer tail. */
	private compact(): void {
		for (let index = this.slots.length - 2; index >= 0; index--) {
			const left = this.slots[index];
			const right = this.slots[index + 1];
			if (left.active || right.active) continue;
			left.text = cutText(redactSecretFragments([left.text, right.text]).filter(Boolean).join("\n\n"), ACP_TEXT_BYTES, {
				tail: true,
			});
			this.slots.splice(index + 1, 1);
		}
	}

	finish(): string {
		for (const { redactor, slot } of this.streams.values()) {
			redactor.finish();
			slot.text = redactor.preview();
		}
		// Redact again across message boundaries before retaining the combined tail.
		const joined = redactSecretFragments(this.slots.map((slot) => slot.text))
			.filter(Boolean)
			.join("\n\n");
		return (
			cutText(redactSecrets(joined), ACP_TEXT_BYTES, { tail: true }) +
			(this.omitted ? "\n[ACP text omitted: text stream identity limit reached.]" : "")
		);
	}
}

type TextUpdate = Extract<SessionNotification["update"], { content: { type: string } }> & {
	content: { type: "text"; text: string };
};

export function textUpdate(notification: SessionNotification): TextUpdate | undefined {
	const update = notification.update;
	return "content" in update && update.content && !Array.isArray(update.content) && update.content.type === "text"
		? (update as TextUpdate)
		: undefined;
}

export function textStreamKey(notification: SessionNotification): string {
	const update = notification.update;
	return JSON.stringify([
		notification.sessionId,
		update.sessionUpdate,
		"messageId" in update ? update.messageId : "compactionId" in update ? update.compactionId : null,
	]);
}

/** Small replies retain their notification shapes; streamed secret spans may cross metadata changes. */
export function redactedUpdates(updates: readonly SessionNotification[], archived: boolean): SessionNotification[] {
	const safe = redactData(updates) as SessionNotification[];
	const groups = new Map<string, Array<{ source: string; update: TextUpdate }>>();
	for (let index = 0; index < updates.length; index++) {
		const source = textUpdate(updates[index]);
		const target = textUpdate(safe[index]);
		if (!source || !target) continue;
		if (archived) target.content.text = "";
		else {
			const key = textStreamKey(updates[index]);
			const group = groups.get(key) ?? [];
			group.push({ source: source.content.text, update: target });
			groups.set(key, group);
		}
	}
	for (const group of groups.values()) {
		const fragments = redactSecretFragments(group.map(({ source }) => source));
		for (let index = 0; index < group.length; index++) group[index].update.content.text = fragments[index];
	}
	return safe;
}

import { redactSecrets } from "../../../../common/src/sanitize.ts";
import type { CappedOutputFile } from "../../utils/output-files.ts";

/** An unterminated line that grows past this is redacted as it stands, so a line without a newline cannot grow the buffer without bound. */
const OPEN_LINE_CAP_CHARS = 64 * 1024;

/**
 * Writes command output to a capped file with secrets redacted (`redactSecrets`). Redaction needs a whole secret in
 * view, so complete lines are redacted and written as they arrive and the unterminated end waits for its newline
 * (or, past the cap, is redacted as it stands). `flush` writes that end when the output is over.
 */
export class RedactingSpill {
	private readonly decoder = new TextDecoder();
	private openLine = "";

	private readonly file: CappedOutputFile;

	constructor(file: CappedOutputFile) {
		this.file = file;
	}

	get path(): string {
		return this.file.path;
	}

	get droppedBytes(): number {
		return this.file.droppedBytes;
	}

	write(data: Buffer): void {
		const text = this.openLine + this.decoder.decode(data, { stream: true });
		const lastNewline = text.lastIndexOf("\n");
		let ready = text.slice(0, lastNewline + 1);
		this.openLine = text.slice(lastNewline + 1);
		if (this.openLine.length > OPEN_LINE_CAP_CHARS) {
			ready += this.openLine;
			this.openLine = "";
		}
		this.emit(ready);
	}

	/** Writes what is still held. Safe to call again. */
	flush(): void {
		const text = this.openLine + this.decoder.decode();
		this.openLine = "";
		this.emit(text);
	}

	close(): Promise<void> {
		return this.file.close();
	}

	private emit(text: string): void {
		if (text) this.file.write(Buffer.from(redactSecrets(text), "utf-8"));
	}
}

import { redactSecrets, secretContinuesAfterLine, unfinishedPrivateKey } from "./sanitize.ts";

/** A private key header still being written: `-----BEGIN RSA ` may become `-----BEGIN RSA PRIVATE KEY-----`. */
const OPEN_KEY_HEADER = /-----BEGIN [A-Z ]*$/;

/**
 * Redacts text that arrives in pieces and releases only what later pieces cannot change. Text is released up to its
 * last whitespace when no credential can continue across it (outside a private key block and after no `token =` or
 * `Bearer` introducer); the held rest waits for the next piece. Every credential pattern but those is unbroken by
 * whitespace, so the released pieces joined equal `redactSecrets` of the whole text, and no part of a credential is
 * ever released before it can be recognized.
 */
export class SecretStream {
	private pending = "";
	private readonly limit: number;

	/** `limit` bounds the held text; past it `push` returns undefined and the caller must stop streaming pieces. */
	constructor(limit = 4096) {
		this.limit = limit;
	}

	/** Characters received but not yet released. */
	get held(): number {
		return this.pending.length;
	}

	/** The redacted text this piece makes stable (often empty), or undefined once the held text passes the limit. */
	push(piece: string): string | undefined {
		const text = this.pending + piece;
		const cut =
			Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"), text.lastIndexOf("\r")) + 1;
		const stable = text.slice(0, cut);
		if (cut > 0 && this.safe(stable)) {
			this.pending = text.slice(cut);
			return redactSecrets(stable);
		}
		this.pending = text;
		return text.length > this.limit ? undefined : "";
	}

	/** The rest, redacted, when no more text follows. */
	flush(): string {
		const rest = redactSecrets(this.pending);
		this.pending = "";
		return rest;
	}

	private safe(stable: string): boolean {
		const tail = stable.slice(-256);
		return (
			!secretContinuesAfterLine(tail.replace(/\s+/gu, " ")) &&
			!OPEN_KEY_HEADER.test(tail) &&
			unfinishedPrivateKey(stable) === undefined
		);
	}
}

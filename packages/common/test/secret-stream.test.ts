import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/sanitize.ts";
import { SecretStream } from "../src/secret-stream.ts";

/** Every release in order, then the flushed rest. */
function stream(pieces: string[]): string[] {
	const secrets = new SecretStream();
	return [...pieces.map((piece) => secrets.push(piece) ?? "<limit>"), secrets.flush()];
}

describe("SecretStream", () => {
	it.each([
		["an API key split inside its body", ["key sk-proj-", "ABCDEFGHIJ", "KLMNOPQRSTUVWX ", "done "]],
		["a Bearer token split after the introducer", ["auth: Bearer", " ", "abcdefghijklmnopqrstuvwxyz012345", " ok "]],
		["an assignment split around the equals sign", ["password ", "= ", "hunter2hunter2", "\nnext "]],
		[
			"a private key split across its header and lines",
			[
				"x -----BEGIN ",
				"RSA PRIVATE ",
				"KEY-----\nMIIBOgIBAAJBAKj34\n",
				"GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA ",
				"PRIVATE KEY-----\nafter ",
			],
		],
	])("releases %s only once it is redacted, matching whole-text redaction", (_name, pieces) => {
		const released = stream(pieces);
		const whole = redactSecrets(pieces.join(""));
		expect(released.join("")).toBe(whole);
		expect(whole).toContain("[redacted]");
		for (const [index, piece] of pieces.entries()) {
			const secretPart = piece.trim();
			if (secretPart.length >= 8 && !whole.includes(secretPart)) expect(released.join("")).not.toContain(secretPart);
			expect(released[index].length).toBeLessThanOrEqual(whole.length);
		}
	});

	it("releases plain prose word by word and holds only the unfinished word", () => {
		const secrets = new SecretStream();
		expect(secrets.push("Hello wor")).toBe("Hello ");
		expect(secrets.held).toBe(3);
		expect(secrets.push("ld again")).toBe("world ");
		expect(secrets.flush()).toBe("again");
	});

	it("reports when the held text passes its bound", () => {
		const secrets = new SecretStream(16);
		expect(secrets.push("a".repeat(10))).toBe("");
		expect(secrets.push("a".repeat(10))).toBeUndefined();
	});
});

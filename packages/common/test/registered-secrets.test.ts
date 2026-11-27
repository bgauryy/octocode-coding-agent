import { afterEach, describe, expect, it } from "vitest";
import {
	clearSecretValues,
	MIN_SECRET_VALUE_LENGTH,
	redactData,
	redactSecretFragments,
	redactSecrets,
	registerSecretValue,
} from "../src/sanitize.ts";
import { SecretStream } from "../src/secret-stream.ts";

/** Opaque on purpose: no prefix, no `key=` around it, so only exact-value redaction can find it. */
const KEY = "synthetic0123456789abcdef0123456789";

describe("registered credential values", () => {
	afterEach(clearSecretValues);

	it("passes an opaque key through until it is registered", () => {
		expect(redactSecrets(`rejected ${KEY}`)).toContain(KEY);
		expect(registerSecretValue(KEY)).toBe(true);
		expect(redactSecrets(`rejected ${KEY} twice ${KEY}`)).toBe("rejected [redacted] twice [redacted]");
	});

	it("redacts it in JSON evidence, including the JSON-escaped form", () => {
		const awkward = 'quote"and\\slash-0123456789';
		registerSecretValue(KEY);
		registerSecretValue(awkward);
		const data = redactData({ message: `bad ${KEY}`, nested: [`x ${awkward}`] });
		expect(JSON.stringify(data)).not.toContain(KEY);
		expect(JSON.stringify(data)).not.toContain("slash-0123456789");
		expect(redactSecrets(JSON.stringify({ value: awkward }))).not.toContain("slash-0123456789");
	});

	it("redacts it across the pieces of a stream and across fragments", () => {
		registerSecretValue(KEY);
		const stream = new SecretStream();
		const released = [stream.push(`bad key ${KEY.slice(0, 10)}`), stream.push(`${KEY.slice(10)} done`), stream.flush()];
		expect(released.join("")).toBe("bad key [redacted] done");
		const fragments = redactSecretFragments([`bad ${KEY.slice(0, 7)}`, `${KEY.slice(7)} end`]).join("");
		expect(fragments).not.toContain(KEY.slice(0, 7));
		expect(fragments).toContain("end");
	});

	it("ignores values too short to register without mangling text, and values with whitespace", () => {
		const short = "a".repeat(MIN_SECRET_VALUE_LENGTH - 1);
		expect(registerSecretValue(short)).toBe(false);
		expect(registerSecretValue("two words in one value")).toBe(false);
		expect(registerSecretValue(undefined)).toBe(false);
		expect(registerSecretValue("   ")).toBe(false);
		expect(redactSecrets(`${short} two words in one value`)).toBe(`${short} two words in one value`);
	});

	it("redacts a registered value that contains regex characters literally", () => {
		const value = "a.b*c+d?e(f)[g]{h}|i^j$k";
		registerSecretValue(value);
		expect(redactSecrets(`got ${value} and aXb*c+d?e(f)[g]{h}|i^j$k`)).toBe(
			"got [redacted] and aXb*c+d?e(f)[g]{h}|i^j$k",
		);
	});

	it("forgets registered values on clear", () => {
		registerSecretValue(KEY);
		clearSecretValues();
		expect(redactSecrets(KEY)).toBe(KEY);
	});

	it("keeps the newest values past its bound", () => {
		for (let index = 0; index < 300; index++) registerSecretValue(`bounded-value-${String(index).padStart(4, "0")}`);
		expect(redactSecrets("bounded-value-0000")).toBe("bounded-value-0000");
		expect(redactSecrets("bounded-value-0299")).toBe("[redacted]");
	});
});

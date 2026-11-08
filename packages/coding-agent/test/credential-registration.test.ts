import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSecretValues, redactSecrets } from "../../common/src/sanitize.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveConfigValue, resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../src/core/config-value.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";

/** Opaque on purpose: no pattern recognizes these, so only a registered value can be removed. */
const ENV_KEY = "envsynthetic0123456789abcdef01234";
const CMD_KEY = "cmdsynthetic0123456789abcdef01234";
const HEADER_KEY = "hdrsynthetic0123456789abcdef01234";
const ACCESS = "accesssynthetic0123456789abcdef012";
const REFRESH = "refreshsynthetic0123456789abcdef01";
const RUNTIME = "runtimesynthetic0123456789abcdef01";

beforeEach(() => clearSecretValues());
afterEach(() => clearSecretValues());

describe("credential values the host resolves", () => {
	it("are registered when a config value resolves from the environment or a command", () => {
		expect(resolveConfigValue("$KEY_VAR", { KEY_VAR: ENV_KEY })).toBe(ENV_KEY);
		expect(redactSecrets(`echoed ${ENV_KEY}`)).toBe("echoed [redacted]");
		expect(resolveConfigValueOrThrow(`!printf ${CMD_KEY}`, "test key")).toBe(CMD_KEY);
		expect(redactSecrets(`echoed ${CMD_KEY}`)).toBe("echoed [redacted]");
	});

	it("are registered for a header from a reference or with a credential name, not for ordinary ones", () => {
		resolveHeadersOrThrow(
			{ "X-Api-Key": HEADER_KEY, "Content-Type": "application/json", Authorization: `Bearer ${ACCESS}` },
			"test",
		);
		expect(redactSecrets(`got ${HEADER_KEY} and ${ACCESS}`)).toBe("got [redacted] and [redacted]");
		expect(redactSecrets("sent application/json")).toBe("sent application/json");
	});

	it("are registered from a stored api key, OAuth tokens, a saved login and a runtime key", async () => {
		const store = AuthStorage.inMemory();
		await store.modify("stored", async () => ({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: 1 }));
		const credentials = new RuntimeCredentials(store);
		expect(redactSecrets(`${ACCESS} ${REFRESH}`)).toBe(`${ACCESS} ${REFRESH}`);
		await credentials.read("stored");
		expect(redactSecrets(`${ACCESS} ${REFRESH}`)).toBe("[redacted] [redacted]");

		clearSecretValues();
		await credentials.modify("login", async () => ({ type: "api_key", key: HEADER_KEY }));
		expect(redactSecrets(`login ${HEADER_KEY}`)).toBe("login [redacted]");

		clearSecretValues();
		credentials.setRuntimeApiKey("runtime", RUNTIME);
		expect(redactSecrets(`login ${RUNTIME}`)).toBe("login [redacted]");
	});
});

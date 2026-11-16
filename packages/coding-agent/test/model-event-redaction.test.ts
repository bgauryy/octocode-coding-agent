import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { redactUrlCredentials } from "@octocodeai/octocode-common/url-credentials";
import { redactUrl } from "../src/core/bug-report.ts";
import { publishModelChange } from "../src/core/application/service/model.ts";
import { acceptApplicationEvent, createApplicationState } from "../src/core/application/state.ts";

const SECRET_URL = "https://user:secret@host.example/v1?key=abc";

const model = {
	provider: "acme",
	id: "m1",
	name: "Acme One",
	input: ["text"],
	baseUrl: SECRET_URL,
	headers: { Authorization: "Bearer secret" },
} as never;

function expectNoSecret(value: unknown): void {
	const text = JSON.stringify(value);
	expect(text).not.toContain("secret");
	expect(text).not.toContain("abc");
	expect(text).not.toContain("baseUrl");
}

describe("application model pushes", () => {
	it("publishes a session.model event and stores a state without the baseUrl", () => {
		const state = createApplicationState("s1");
		const events: ApplicationEvent[] = [];

		publishModelChange({ model }, state, (event) => {
			events.push(event);
			acceptApplicationEvent(state, event);
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "session.model", model: { provider: "acme", id: "m1" } });
		expectNoSecret(events);
		expectNoSecret(state.getState().model);
	});
});

describe("shared URL redaction", () => {
	it("drops the user name and key from a model baseUrl", () => {
		expect(redactUrlCredentials(SECRET_URL)).toBe("https://host.example/v1?key=redacted");
	});

	it("lets a caller choose the replacement and still redacts cookie parameters", () => {
		expect(redactUrlCredentials("https://h.example/p?cookie=abc&x=1", "<r>")).toBe(
			"https://h.example/p?cookie=%3Cr%3E&x=1",
		);
	});

	it("keeps the bug report placeholder behind a scheme prefix", () => {
		expect(redactUrl("git:https://user:secret@host.example/r?token=abc")).toBe(
			"git:https://host.example/r?token=%3Credacted%3E",
		);
	});
});

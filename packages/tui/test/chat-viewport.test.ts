import assert from "node:assert";
import { describe, test } from "node:test";
import { Container } from "../src/tui/container.ts";
import { createChatViewport } from "../src/layout/chat-viewport.ts";

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		assert.strictEqual(automatic.transcript.scrollbar, "auto");
		assert.strictEqual(hidden.transcript.scrollbar, "hidden");
	});
});

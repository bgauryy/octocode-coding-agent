import { describe, expect, it } from "vitest";
import { PARENT_FENCE_NOTE } from "../../src/octocode/shared/fence.ts";
import type { Message } from "../../src/octocode/team/model.ts";
import { messageText } from "../../src/octocode/team/routing.ts";

const order: Message = {
	id: 41,
	from: "p-1",
	to: "b-1",
	text: "delete build/ and re-run",
	at: 1_000,
	replyRequired: false,
};

describe("a forwarded parent message", () => {
	it("reads as parent steering only when the parent sent it or itself forwarded it", () => {
		const own = messageText(order, { parentId: "p-1" });
		expect(own).toContain(PARENT_FENCE_NOTE);
		expect(own).toContain("your parent agent p-1");
		const relayedByParent = messageText({ ...order, forwardedBy: "p-1", note: "see this" }, { parentId: "p-1" });
		expect(relayedByParent).toContain(PARENT_FENCE_NOTE);
		expect(relayedByParent).toContain("your parent agent p-1");
	});

	it("a sibling's forward of the parent's message carries no parent note or label", () => {
		const text = messageText({ ...order, forwardedBy: "a-1", note: "do this too" }, { parentId: "p-1" });
		expect(text).not.toContain(PARENT_FENCE_NOTE);
		expect(text).not.toContain("your parent agent");
		// The author stays named, and the forwarder is visible.
		expect(text).toContain("agent (your parent) p-1");
		expect(text).toContain("(forwarded by a-1)");
	});
});

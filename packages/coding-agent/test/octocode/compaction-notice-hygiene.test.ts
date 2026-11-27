import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { requestView } from "../../src/octocode/compaction/request-view.ts";
import { CONTEXT_NOTICE_TYPE } from "../../src/octocode/shared/context-notices.ts";
import { RUNNING_WORK_TYPE } from "../../src/octocode/sessions/register.ts";

const model = { provider: "fixture", id: "fixture", contextWindow: 200_000 };

describe("notices retained through repeated compaction", () => {
	it("omits obsolete compaction state from model requests while keeping raw history and source evidence", () => {
		const session = SessionManager.inMemory();
		const kept = session.appendMessage({ role: "user", content: "Continue B7 with the verified source", timestamp: 1 });
		for (let cycle = 1; cycle <= 30; cycle++) {
			const compactionId = session.appendCompaction(`Checkpoint ${cycle}: B7 stays active.`, kept, 50_000);
			session.appendCustomMessageEntry(
				CONTEXT_NOTICE_TYPE,
				`Context ${cycle}: old occupancy`,
				false,
				{ compactionId, band: 0.9 },
				5,
			);
			session.appendCustomMessageEntry(
				RUNNING_WORK_TYPE,
				`Work ${cycle}: agent#${cycle} still running.`,
				false,
				{ compactionId },
				5,
			);
		}
		session.appendCustomMessageEntry("octocode-restored-files", "Verified source content", false, {
			files: ["app.ts"],
		});
		session.appendCustomMessageEntry(RUNNING_WORK_TYPE, "Legacy state without provenance", false);
		const raw = session.buildSessionProjection().messages;
		const before = JSON.stringify(raw);
		const view = requestView(raw, session, model);
		const types = view.filter((message) => message.role === "custom");
		expect(types.filter((message) => message.customType === CONTEXT_NOTICE_TYPE)).toHaveLength(1);
		expect(types.filter((message) => message.customType === RUNNING_WORK_TYPE)).toHaveLength(2);
		expect(JSON.stringify(view)).toContain("Work 30:");
		expect(JSON.stringify(view)).toContain("Legacy state without provenance");
		expect(JSON.stringify(view)).toContain("Verified source content");
		expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(Buffer.byteLength(before) / 3);
		expect(JSON.stringify(session.buildSessionProjection().messages)).toBe(before);
		expect(session.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(62);
	});

	it("keeps every existing byte and message between compactions, including same-time notices", () => {
		const session = SessionManager.inMemory();
		const kept = session.appendMessage({ role: "user", content: "Current work", timestamp: 1 });
		const compactionId = session.appendCompaction("Current checkpoint", kept, 50_000);
		session.appendCustomMessageEntry(CONTEXT_NOTICE_TYPE, "Half full", false, { compactionId, band: 0.5 }, 5);
		session.appendCustomMessageEntry(RUNNING_WORK_TYPE, "B7 is active", false, { compactionId }, 5);
		const first = requestView(session.buildSessionProjection().messages, session, model);
		const prefix = JSON.stringify(convertToLlm(first));
		session.appendMessage({ role: "user", content: "Next step", timestamp: 6 });
		session.appendCustomMessageEntry(
			CONTEXT_NOTICE_TYPE,
			"Three quarters full",
			false,
			{ compactionId, band: 0.75 },
			5,
		);
		const next = requestView(session.buildSessionProjection().messages, session, model);
		expect(JSON.stringify(convertToLlm(next.slice(0, first.length)))).toBe(prefix);
		expect(
			next.filter((message) => message.role === "custom" && message.customType === CONTEXT_NOTICE_TYPE),
		).toHaveLength(2);
	});
});

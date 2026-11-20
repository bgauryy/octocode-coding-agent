import type { ApplicationActivity, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { activityCard, ApplicationProjection } from "../src/app/live/model.ts";
import { NoticeToasts } from "../src/app/live/notice-toasts.ts";

const snapshot = (activities: ApplicationActivity[], sessionId = "s"): ApplicationSnapshot => ({
	sessionId,
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
	activities,
});
const notice = (id: string, text: string, level = "info"): ApplicationActivity => ({
	id,
	kind: "notice",
	at: 1,
	text,
	source: "live",
	data: { level },
	...(level === "error" ? { outcome: "failed" as const } : {}),
});

describe("session notices", () => {
	it("toasts a notice that arrives after the session was first seen, once, and keeps history quiet", () => {
		const toasts = new NoticeToasts();
		const old = notice("n1", "Cache warmed: $0.02");
		expect(toasts.next(snapshot([old]))).toBeUndefined();
		const saved: ApplicationActivity = { id: "entry:e1", kind: "custom", at: 2, text: "Memory: +1", source: "session" };
		expect(toasts.next(snapshot([old, saved]))).toBeUndefined();
		const fresh = notice("n2", "Model not answering for 21s (faux/model)", "warning");
		expect(toasts.next(snapshot([old, saved, fresh]))).toEqual({
			id: "n2",
			text: "Model not answering for 21s (faux/model)",
			level: "warning",
		});
		// A repeated snapshot or a reconnect raises nothing new.
		expect(toasts.next(snapshot([old, saved, fresh]))).toBeUndefined();
		// Another session's notices are its history.
		expect(toasts.next(snapshot([notice("m1", "elsewhere")], "t"))).toBeUndefined();
		expect(toasts.next(snapshot([notice("m1", "elsewhere"), notice("m2", "Bad hook", "error")], "t"))).toMatchObject({
			level: "error",
		});
	});

	it("labels a notice line by its level in the feed", () => {
		const card = (activity: ApplicationActivity) =>
			activityCard({ id: 1, at: 1, type: "session.activity", text: activity.text, activity });
		expect([card(notice("n", "Cache warmed")).label, card(notice("n", "Cache warmed")).tone]).toEqual([
			"Notice",
			"neutral",
		]);
		expect([card(notice("n", "Quiet", "warning")).label, card(notice("n", "Quiet", "warning")).tone]).toEqual([
			"Warning",
			"warning",
		]);
	});

	it("shows a notice that repeats a saved line once in the feed", () => {
		const line = "Memory reflection: workspace MEMORY.md +1 −0 lines.";
		const saved: ApplicationActivity = { id: "entry:e1", kind: "custom", at: 1, text: line, source: "session" };
		const feed = new ApplicationProjection().update(
			snapshot([saved, notice("n1", line), notice("n2", "Cache warmed")]),
			1,
		);
		expect(feed.map((event) => event.activity?.id)).toEqual(["entry:e1", "n2"]);
	});
});

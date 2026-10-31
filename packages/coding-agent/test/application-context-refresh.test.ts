import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import { afterEach, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationService } from "../src/core/application/service.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});

function fixture() {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const first = { role: "user", content: "question", timestamp: 1 };
	const answer = { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop", timestamp: 2 };
	const session = {
		sessionId: "refresh",
		isStreaming: false,
		messages: [first, answer] as object[],
		branch: [
			{ id: "e1", type: "message" },
			{ id: "e2", type: "message" },
		] as { id: string; type: string }[],
		sessionManager: { getBranch: () => session.branch },
		subscribe(listener: typeof receive) {
			receive = listener;
			return () => {
				receive = undefined;
			};
		},
	};
	const service = new ApplicationService(session as unknown as AgentSession);
	services.push(service);
	const events: ApplicationEvent[] = [];
	service.subscribe((event) => events.push(event));
	const connection = service.connect();
	const frames = connection[Symbol.asyncIterator]();
	return {
		service,
		session,
		events,
		frames,
		emit: (event: unknown) => receive?.(event as AgentSessionEvent),
	};
}

it("keeps the transcript and live views when a turn boundary rebuilds equal context on a grown branch", async () => {
	const f = fixture();
	const initial = (await f.frames.next()).value;
	expect(initial).toMatchObject({ type: "snapshot" });
	const ids = f.service.getSnapshot().messages.map((message) => message.id);

	// turn_end: the context is rebuilt from the session file, reusing persisted objects or equal copies.
	f.session.messages = [f.session.messages[0], structuredClone(f.session.messages[1])];
	f.session.branch = [...f.session.branch, { id: "e3", type: "custom" }];
	f.emit({ type: "session_context_changed" });
	const next = { role: "user", content: "follow-up", timestamp: 3 };
	f.session.messages.push(next);
	f.emit({ type: "message_end", message: next });

	const frame = (await f.frames.next()).value;
	expect(frame).toMatchObject({ type: "event", cursor: { epoch: initial.cursor.epoch } });
	expect(f.events.map((event) => event.type)).not.toContain("session.reset");
	const snapshot = f.service.getSnapshot();
	expect(snapshot.messages.map((message) => message.id).slice(0, 2)).toEqual(ids);
	expect(snapshot.messages.map((message) => message.text)).toEqual(["question", "answer", "follow-up"]);
	expect(f.service.history({ before: ids[1] }).messages.map((message) => message.text)).toEqual(["question"]);
});

it("still resets when the content changes or the branch was replaced rather than extended", async () => {
	const changed = fixture();
	await changed.frames.next();
	changed.session.messages = [{ role: "user", content: "edited", timestamp: 1 }, changed.session.messages[1]];
	changed.session.branch = [...changed.session.branch, { id: "e3", type: "context_edit" }];
	changed.emit({ type: "session_context_changed" });
	expect((await changed.frames.next()).value).toMatchObject({ type: "resync", reason: "session-changed" });
	expect(changed.events.at(-1)).toMatchObject({ type: "session.reset" });

	const navigated = fixture();
	await navigated.frames.next();
	navigated.session.messages = [...navigated.session.messages];
	navigated.session.branch = [
		{ id: "e1", type: "message" },
		{ id: "other", type: "message" },
	];
	navigated.emit({ type: "session_context_changed" });
	expect((await navigated.frames.next()).value).toMatchObject({ type: "resync" });
});

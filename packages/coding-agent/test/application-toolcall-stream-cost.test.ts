import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStreamingJsonThrottled } from "@octocodeai/octocode-ai";
import type { ApplicationEvent, ApplicationFrame, ApplicationMessage } from "@octocodeai/octocode-contracts";
import { ApplicationStream } from "../../webview/src/application-stream.ts";
import { redactData } from "../../common/src/sanitize.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { normalizeApplicationMessage } from "../src/core/application/normalize.ts";
import { ApplicationService } from "../src/core/application/service.ts";
import { ApplicationTranscript } from "../src/core/application/transcript.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	vi.restoreAllMocks();
});

type Args = { path: string; content: string };
type Call = { type: "toolCall"; id: string; name: string; arguments: Args };

/**
 * A service fed by a provider that streams one `write` call. `next` gives the arguments after a delta: a fresh object
 * per delta (a custom source), or the throttled partial-JSON parse every built-in provider uses.
 */
function fixture(next: (previous: Args, json: string) => Args) {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "toolcall-cost",
		messages: [] as unknown[],
		isStreaming: false,
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
	const emit = (event: unknown) => receive?.(event as AgentSessionEvent);
	const block: Call = { type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.txt", content: "" } };
	const partial = { role: "assistant", content: [] as Call[], stopReason: "stop" };
	const update = (assistantMessageEvent: object) =>
		emit({ type: "message_update", message: partial, assistantMessageEvent: { ...assistantMessageEvent, partial } });
	let json = '{"path":"a.txt","content":"';
	return {
		service,
		events,
		block,
		start() {
			emit({ type: "message_start", message: partial });
			partial.content.push(block);
			update({ type: "toolcall_start", contentIndex: 0 });
		},
		delta(piece: string) {
			json += piece;
			block.arguments = next(block.arguments, json);
			update({ type: "toolcall_delta", contentIndex: 0, delta: piece });
		},
		/** Ends the call (parsing its arguments unless `keep`) and the message; returns the final source message. */
		end(keep = false) {
			if (!keep) block.arguments = JSON.parse(`${json}"}`) as Args;
			update({ type: "toolcall_end", contentIndex: 0, toolCall: block });
			const final = { ...partial, content: [{ ...block }], stopReason: "toolUse" };
			emit({ type: "message_end", message: final });
			return final;
		},
	};
}

const perDelta = (piece: string) => (previous: Args) => ({ ...previous, content: previous.content + piece });
const throttled = (previous: Args, json: string) => parseStreamingJsonThrottled<Args>(previous, json);

const deltas = (events: ApplicationEvent[]) =>
	events.filter(
		(event): event is Extract<ApplicationEvent, { type: "message.delta" }> => event.type === "message.delta",
	);

/** Whole-message normalizes the transcript runs, and the argument characters they cover when they run. */
function countNormalizes() {
	const original = ApplicationTranscript.prototype.normalize;
	let chars = 0;
	const normalize = vi.spyOn(ApplicationTranscript.prototype, "normalize").mockImplementation(function (
		this: ApplicationTranscript,
		value,
		id,
	) {
		const content = (value as { content?: unknown }).content;
		if (Array.isArray(content))
			for (const block of content as Partial<Call>[]) chars += block.arguments?.content.length ?? 0;
		return original.call(this, value, id);
	});
	return () => ({ calls: normalize.mock.calls.length, chars });
}

const SIZE = 200 * 1024;
const PIECE = "x".repeat(100);

describe("streamed tool-call arguments", () => {
	for (const [label, source] of [
		["the throttled provider parse", throttled],
		["a new arguments object per delta", perDelta(PIECE)],
	] as const)
		it(`projects a 200 KB argument from ${label} in linear total work`, () => {
			const f = fixture(source);
			f.service.getSnapshot();
			f.start();
			const work = countNormalizes();
			const count = SIZE / PIECE.length;
			for (let i = 0; i < count; i++) f.delta(PIECE);
			const { calls, chars } = work();
			// Re-normalizing the whole call per delta would be 2 048 normalizes covering about SIZE² / 200 (210 M)
			// characters. Every delta up to 8 KB normalizes (82 here), then one per eighth of growth (about 28 more).
			expect(calls).toBeLessThan(150);
			expect(chars).toBeLessThan(16 * SIZE);
			expect(deltas(f.events).length).toBeLessThan(150);
			// The display lags the source by at most an eighth.
			const shown = f.service.getSnapshot().messages.at(-1)!;
			expect(shown.full?.size).toBeGreaterThan((SIZE * 7) / 8);
		});

	it("publishes every delta of a small call, so live previews keep their cadence", () => {
		const piece = "y".repeat(20);
		const f = fixture(perDelta(piece));
		f.service.getSnapshot();
		f.start();
		const before = deltas(f.events).length;
		for (let i = 0; i < 100; i++) f.delta(piece);
		const published = deltas(f.events).slice(before);
		expect(published).toHaveLength(100);
		expect(published.at(-1)!.content?.[0]).toMatchObject({ arguments: { content: piece.repeat(100) } });
	});

	it("keeps snapshots equal to the last published display and ends with exactly the whole normalize", async () => {
		const f = fixture(perDelta(PIECE));
		const frames: ApplicationFrame[] = [];
		const iterator = f.service.connect({})[Symbol.asyncIterator]();
		void (async () => {
			for (let next = await iterator.next(); !next.done; next = await iterator.next()) frames.push(next.value);
		})();
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		await settle();
		f.start();
		for (let i = 0; i < SIZE / PIECE.length; i++) {
			f.delta(PIECE);
			// A view attaching between deltas sees what the last published delta showed.
			if (i % 97 === 0) {
				const last = deltas(f.events).at(-1)!;
				const shown = f.service.getSnapshot().messages.at(-1)!;
				expect({ text: shown.text, content: shown.content, full: shown.full }).toEqual({
					text: last.text,
					content: last.content,
					full: last.full,
				});
			}
			// A socket drains between deltas; a burst of 60 KB frames would overflow its 256 KB queue.
			await settle();
		}
		const final = f.end();
		await settle();
		const completed = f.events.findLast((event) => event.type === "message.completed");
		const message = completed?.type === "message.completed" ? completed.message : undefined;
		const expected = normalizeApplicationMessage(final, message!.id, new ApplicationAssets({ memory: true }));
		expect({ ...message, order: undefined }).toEqual({ ...expected, order: undefined });
		const view = new ApplicationStream();
		for (const frame of frames) expect(view.accept(frame)).not.toBe("resync");
		const sequences = frames.flatMap((frame) => (frame.type === "event" ? [frame.cursor.sequence] : []));
		expect(sequences).toEqual(sequences.map((_, index) => sequences[0] + index));
		expect(view.snapshot!.messages).toEqual(redactData(f.service.getSnapshot().messages));
	});

	it("shows arguments mutated in place only from the next new object or the end of the call", () => {
		const f = fixture((previous) => previous);
		f.service.getSnapshot();
		f.start();
		f.block.arguments = { path: "a.txt", content: "first" };
		f.delta("first");
		const shown = (): ApplicationMessage => f.service.getSnapshot().messages.at(-1)!;
		expect(shown().content?.[0]).toMatchObject({ arguments: { content: "first" } });
		// Same block, same arguments object: the transcript does not re-normalize, so the display keeps the old value.
		f.block.arguments.content = "first second";
		f.delta(" second");
		expect(shown().content?.[0]).toMatchObject({ arguments: { content: "first" } });
		f.block.arguments.content = "first second third";
		f.end(true);
		expect(shown().content?.[0]).toMatchObject({ arguments: { content: "first second third" } });
	});
});

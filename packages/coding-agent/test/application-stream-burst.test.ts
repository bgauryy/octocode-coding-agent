import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationFrame } from "@octocodeai/octocode-contracts";
import { ApplicationStream } from "../../webview/src/application-stream.ts";
import { redactData } from "@octocodeai/octocode-common/sanitize";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { normalizeApplicationMessage } from "../src/core/application/normalize.ts";
import { ApplicationService } from "../src/core/application/service.ts";
import { createApplicationState } from "../src/core/application/state.ts";
import { ApplicationTranscript } from "../src/core/application/transcript.ts";
import { TranscriptStream } from "../src/core/application/transcript-stream.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	vi.restoreAllMocks();
});

type Block = { type: "thinking"; thinking: string } | { type: "text"; text: string };
/** One provider event: how it changes the partial message, and the update the agent later delivers for it. */
type ProviderEvent = { apply: () => void; update: Record<string, unknown> };

/**
 * A reply of a thinking block and a text block, as a provider produces it. The provider extends its partial message
 * as pieces arrive while the agent delivers each update in turn, so a delivered update finds the partial `lead` events
 * ahead of it (later deltas, the next block's start, already in place).
 */
function reply(thinking: string[], text: string[]) {
	const partial = { role: "assistant", content: [] as Block[], stopReason: "stop" };
	const block = <T extends Block["type"]>(index: number) => partial.content[index] as Extract<Block, { type: T }>;
	const events: ProviderEvent[] = [
		{ apply: () => partial.content.push({ type: "thinking", thinking: "" }), update: { type: "thinking_start" } },
		...thinking.map((delta) => ({
			apply: () => void (block<"thinking">(0).thinking += delta),
			update: { type: "thinking_delta", delta },
		})),
		{ apply: () => {}, update: { type: "thinking_end" } },
		{ apply: () => partial.content.push({ type: "text", text: "" }), update: { type: "text_start", contentIndex: 1 } },
		...text.map((delta) => ({
			apply: () => void (block<"text">(1).text += delta),
			update: { type: "text_delta", contentIndex: 1, delta },
		})),
		{ apply: () => {}, update: { type: "text_end", contentIndex: 1 } },
	].map((event) => ({ ...event, update: { contentIndex: 0, ...event.update } }));
	return {
		partial,
		/** Deliver every update through `deliver`, the provider staying `lead` events ahead. */
		play(lead: number, deliver: (event: AgentSessionEvent) => void) {
			deliver({ type: "message_start", message: { ...partial } } as never);
			const send = (event: ProviderEvent) =>
				deliver({
					type: "message_update",
					message: { ...partial },
					assistantMessageEvent: { ...event.update, partial },
				} as never);
			events.forEach((event, index) => {
				event.apply();
				if (index >= lead) send(events[index - lead]);
			});
			for (const event of events.slice(Math.max(0, events.length - lead))) send(event);
		},
		end(deliver: (event: AgentSessionEvent) => void) {
			deliver({
				type: "message_end",
				message: { ...partial, content: partial.content.map((item) => ({ ...item })) },
			} as never);
		},
	};
}

const words = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix}${i} `);

/** How often the transcript extended a message from the delta alone, and how often it normalized it whole. */
function countExtends() {
	const extend = TranscriptStream.prototype.extend;
	const counts = { fast: 0, whole: 0 };
	vi.spyOn(TranscriptStream.prototype, "extend").mockImplementation(function (this: TranscriptStream, ...args) {
		const result = extend.apply(this, args);
		counts[result ? "fast" : "whole"]++;
		return result;
	});
	return counts;
}

describe("streaming while the provider runs ahead of delivered updates", () => {
	it("keeps extending from the delta alone and ends equal to normalizing the whole partial message", () => {
		const counts = countExtends();
		// Long enough that the text block turns into a preview with a whole-text asset midway.
		const source = reply(words(150, "think"), words(900, "word"));
		const transcript = new ApplicationTranscript(createApplicationState("s"));
		source.play(8, (event) => transcript.message(event as never, () => {}));
		// Each start and end normalizes once, and so does the thinking delta that first finds the text block in the
		// source; every other delta, including those the display already held, is followed from the delta alone.
		expect(counts).toEqual({ fast: 1049, whole: 5 });
		const shown = [...transcript.messages.values()].at(-1)!;
		const whole = normalizeApplicationMessage(
			{ ...source.partial, stopReason: "pending" },
			shown.id,
			transcript.assets,
		);
		expect({ ...shown, order: undefined }).toEqual({ ...whole, order: undefined });
		const full = shown.content?.[1]?.type === "text" ? shown.content[1].full : undefined;
		expect(transcript.assets.get(full!.id)?.data).toBe((source.partial.content[1] as { text: string }).text);
	});

	it("streams appends to views that fold into the terminal's transcript, with a split secret never sent", async () => {
		let receive: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			sessionId: "burst-test",
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
		const frames: ApplicationFrame[] = [];
		const iterator = service.connect()[Symbol.asyncIterator]();
		void (async () => {
			for (let next = await iterator.next(); !next.done; next = await iterator.next()) frames.push(next.value);
		})();
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		await settle();
		const text = words(120, "word");
		text.splice(60, 0, "sk-proj-", "ABCDEFGHIJ", "KLMNOPQRSTU", "VWXYZ0123 ");
		const source = reply(words(40, "think"), text);
		source.play(6, (event) => receive?.(event));
		await settle();
		const sent = frames.slice();
		const appends = frames.filter((frame) => frame.type === "event" && frame.event.type === "message.delta");
		expect(
			appends.filter((frame) => frame.type === "event" && "block" in frame.event && frame.event.block),
		).toHaveLength(
			// Every word releases at once; the four secret pieces release together with the word after them.
			40 + 120 + 1,
		);
		const view = new ApplicationStream();
		const fold = () => {
			for (const frame of frames.splice(0)) expect(view.accept(frame)).not.toBe("resync");
			return view.snapshot!.messages;
		};
		// Mid-stream, once the updates the provider ran ahead with are delivered, and after the end.
		expect(fold()).toEqual(redactData(service.getSnapshot().messages));
		source.end((event) => receive?.(event));
		await settle();
		expect(fold()).toEqual(redactData(service.getSnapshot().messages));
		for (const part of ["ABCDEFGHIJ", "KLMNOPQRSTU", "VWXYZ0123"]) expect(JSON.stringify(sent)).not.toContain(part);
	});
});

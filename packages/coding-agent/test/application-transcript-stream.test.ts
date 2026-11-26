import { describe, expect, it, vi } from "vitest";
import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { normalizeApplicationMessage } from "../src/core/application/normalize.ts";
import { createApplicationState } from "../src/core/application/state.ts";
import { ApplicationTranscript } from "../src/core/application/transcript.ts";

type Block = { type: string; text?: string; thinking?: string; annotations?: object[] };

/** A provider's partial message, extended in place, with each piece reported as pi-ai providers report it. */
function provider(transcript: ApplicationTranscript, published: ApplicationEvent[]) {
	const partial = { role: "assistant", content: [] as Block[], stopReason: "stop", usage: { output: 0 } };
	const send = (event: object) =>
		transcript.message(event as Extract<AgentSessionEvent, { type: "message_update" }>, (out) => {
			published.push(out);
		});
	const update = (assistantMessageEvent: object) =>
		send({ type: "message_update", message: partial, assistantMessageEvent: { ...assistantMessageEvent, partial } });
	return {
		partial,
		start: () => send({ type: "message_start", message: partial }),
		open(type: "text" | "thinking") {
			partial.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
			update({ type: `${type}_start`, contentIndex: partial.content.length - 1 });
		},
		delta(index: number, delta: string) {
			const block = partial.content[index];
			if (block.type === "text") block.text += delta;
			else block.thinking += delta;
			partial.usage = { output: partial.usage.output + 1 };
			update({ type: `${block.type}_delta`, contentIndex: index, delta });
		},
		annotate(index: number) {
			(partial.content[index].annotations ??= []).push({ type: "url_citation", url: "https://example.com" });
			update({ type: "content_update", contentIndex: index });
		},
	};
}

describe("transcript streaming", () => {
	it("extends streamed blocks per token exactly as normalizing the whole partial message would", () => {
		const transcript = new ApplicationTranscript(createApplicationState("s"));
		const published: ApplicationEvent[] = [];
		const p = provider(transcript, published);
		const puts = vi.spyOn(transcript.assets, "put");
		p.start();
		p.open("thinking");
		p.open("text");
		const id = published[0].type === "message.started" ? published[0].message.id : "";
		// Each block passes the preview size; pieces include a surrogate pair split across deltas.
		const pieces = Array.from({ length: 3000 }, (_, i) => (i === 700 ? ["\uD83D", "\uDE00 "] : [`w${i} `])).flat();
		for (const [i, piece] of pieces.entries()) {
			p.delta(i % 3 === 0 ? 0 : 1, piece);
			if (i === 900) p.annotate(1);
			const shown = transcript.messages.get(id)!;
			const expected = normalizeApplicationMessage(
				{ ...p.partial, stopReason: "pending" },
				id,
				new ApplicationAssets({ memory: true }),
			);
			expect(shown).toEqual({ ...expected, complete: false, status: "streaming", order: shown.order });
			const last = published.at(-1)!;
			expect(last.type === "message.delta" && last.content).toEqual(expected.content);
		}
		for (const [index, block] of transcript.messages.get(id)!.content!.entries()) {
			const raw = p.partial.content[index];
			expect(block.type === "text" || block.type === "thinking" ? block.full : undefined).toBeDefined();
			if (block.type === "text" || block.type === "thinking")
				expect(transcript.assets.get(block.full!.id)?.data).toBe(raw.text ?? raw.thinking);
		}
		// Whole-text assets are written whole only when a block first needs one or a delta splits a character.
		expect(puts.mock.calls.filter(([, mime]) => mime === "text/plain").length).toBeLessThan(10);
	});

	it("keeps an earlier streamed snapshot unchanged by later deltas (structural sharing is immutable)", () => {
		const transcript = new ApplicationTranscript(createApplicationState("s"));
		const published: ApplicationEvent[] = [];
		const p = provider(transcript, published);
		p.start();
		p.open("thinking");
		p.open("text");
		const id = published[0].type === "message.started" ? published[0].message.id : "";
		const pieces = Array.from({ length: 2000 }, (_, i) => `w${i} `);
		for (const [i, piece] of pieces.entries()) p.delta(i % 3 === 0 ? 0 : 1, piece);
		// Retain the whole displayed snapshot and its content array at this point.
		const early = transcript.messages.get(id)!;
		const earlyContent = early.content;
		const earlyExpected = normalizeApplicationMessage(
			{ ...p.partial, stopReason: "pending" },
			id,
			new ApplicationAssets({ memory: true }),
		);
		const frozen = structuredClone(early);
		// Many more deltas on the same blocks; only the changed block's tail should differ in the live message.
		for (const i of pieces.keys()) p.delta(i % 3 === 0 ? 0 : 1, `x${i} `);
		const live = transcript.messages.get(id)!;
		expect(live).not.toBe(early);
		expect(live.content).not.toBe(earlyContent);
		// The retained snapshot is byte-for-byte what it was before the later deltas: structural sharing built new
		// objects and never mutated the earlier message in place.
		expect(early).toEqual(frozen);
		expect(early).toEqual({ ...earlyExpected, complete: false, status: "streaming", order: early.order });
	});
});

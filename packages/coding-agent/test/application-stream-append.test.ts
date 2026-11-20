import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationCursor, ApplicationFrame } from "@octocodeai/octocode-contracts";
import { ApplicationStream } from "@octocodeai/octocode-projections";
import { redactData } from "@octocodeai/octocode-common/sanitize";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationService } from "../src/core/application/service.ts";

const SECRET = ["sk-proj-", "ABCDEFGHIJ", "KLMNOPQRSTU", "VWXYZ0123 "];
const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});

function fixture() {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "append-test",
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
	const emit = (event: unknown) => receive?.(event as AgentSessionEvent);
	// A provider extends one partial message in place and reports each piece, as pi-ai providers do.
	const partial = { role: "assistant", content: [] as { type: string; text: string }[], stopReason: "stop" };
	const update = (assistantMessageEvent: object) =>
		emit({ type: "message_update", message: partial, assistantMessageEvent: { ...assistantMessageEvent, partial } });
	return {
		service,
		start() {
			emit({ type: "message_start", message: partial });
			partial.content.push({ type: "text", text: "" });
			update({ type: "text_start", contentIndex: 0 });
		},
		token(delta: string) {
			partial.content[0].text += delta;
			update({ type: "text_delta", contentIndex: 0, delta });
		},
		end() {
			update({ type: "text_end", contentIndex: 0, content: partial.content[0].text });
			emit({ type: "message_end", message: { ...partial, content: [{ ...partial.content[0] }] } });
		},
	};
}

/** Frames a connection delivers, collected as they arrive. */
function reader(service: ApplicationService, cursor?: ApplicationCursor): ApplicationFrame[] {
	const frames: ApplicationFrame[] = [];
	const iterator = service.connect(cursor ? { cursor } : {})[Symbol.asyncIterator]();
	void (async () => {
		for (let next = await iterator.next(); !next.done; next = await iterator.next()) frames.push(next.value);
	})();
	return frames;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const fold = (frames: ApplicationFrame[], view = new ApplicationStream()) => {
	for (const frame of frames) expect(view.accept(frame)).not.toBe("resync");
	return view;
};
/** Event frames only: folding them again into a view ignores the ones it already applied. */
const events = (frames: ApplicationFrame[]) => frames.filter((frame) => frame.type === "event");
const tokens = (count: number) =>
	Array.from({ length: count }, (_, i) => (i === count - 3 ? SECRET : [`word${i} `])).flat();

describe("append-only message deltas", () => {
	it("streams a long reply as bounded appends that fold into the terminal's transcript, with a split secret never sent", async () => {
		const f = fixture();
		const frames = reader(f.service);
		await settle();
		f.start();
		// A connection holds at most 200 frames, so the view reads between bursts as a socket would.
		for (const [index, piece] of tokens(2000).entries()) {
			f.token(piece);
			if (index % 100 === 99) await settle();
		}
		await settle();
		// A view connecting mid-stream holds exactly what the streamed view holds, and both continue alike.
		const late = reader(f.service);
		await settle();
		const streamed = fold(frames);
		const joined = fold(late);
		expect(joined.snapshot!.messages).toEqual(streamed.snapshot!.messages);
		f.token("tail");
		f.end();
		await settle();

		const deltas = frames.flatMap((frame) =>
			frame.type === "event" && frame.event.type === "message.delta" ? [frame] : [],
		);
		expect(deltas.length).toBeGreaterThan(1900);
		for (const frame of deltas) {
			if (frame.type !== "event" || frame.event.type !== "message.delta") continue;
			if (frame.event.block === undefined) continue;
			expect(frame.event.text).toBeUndefined();
			expect(frame.event.content).toBeUndefined();
			// Bounded by the piece and a fixed envelope (cursor, ids, a preview asset), not by the message length.
			expect(JSON.stringify(frame).length).toBeLessThan(frame.event.delta.length + 600);
		}
		const wire = JSON.stringify(frames) + JSON.stringify(late);
		for (const part of ["ABCDEFGHIJ", "KLMNOPQRSTU", "VWXYZ0123"]) expect(wire).not.toContain(part);

		const terminal = redactData(f.service.getSnapshot().messages);
		for (const [view, received] of [
			[streamed, frames],
			[joined, late],
		] as const)
			expect(fold(events(received), view).snapshot!.messages).toEqual(terminal);
		expect(terminal[0].text).toContain("[redacted]");
	});

	it("resynchronizes after a lost or reordered append and then matches a view that saw every frame", async () => {
		const f = fixture();
		const frames = reader(f.service);
		await settle();
		f.start();
		for (const piece of tokens(40)) f.token(piece);
		await settle();
		const appends = frames.filter((frame) => frame.type === "event" && frame.event.type === "message.delta");
		const lossy = new ApplicationStream();
		const results = frames.filter((frame) => frame !== appends[5]).map((frame) => lossy.accept(frame));
		expect(results).toContain("resync");
		const swapped = new ApplicationStream();
		const order = [...frames];
		const at = order.indexOf(appends[3]);
		[order[at], order[at + 1]] = [order[at + 1], order[at]];
		expect(order.map((frame) => swapped.accept(frame))).toContain("resync");
		const fresh = reader(f.service);
		await settle();
		for (const view of [lossy, swapped]) {
			expect(view.accept(fresh[0])).toBe("applied");
			expect(view.snapshot).toEqual(fold(frames).snapshot);
		}
	});

	it("resumes a reconnecting view from its cursor mid-stream", async () => {
		const f = fixture();
		const frames = reader(f.service);
		await settle();
		f.start();
		for (const piece of tokens(20)) f.token(piece);
		await settle();
		const view = fold(frames);
		for (const piece of tokens(20)) f.token(piece);
		const resumed = reader(f.service, view.cursor);
		await settle();
		expect(resumed[0].type).toBe("resumed");
		for (const frame of resumed.slice(1)) expect(view.accept(frame)).toBe("applied");
		f.end();
		await settle();
		expect(fold(events(resumed), view).snapshot!.messages).toEqual(redactData(f.service.getSnapshot().messages));
	});

	it("encodes nothing before a view first connects, and a view connecting mid-stream continues the streamed block", async () => {
		const f = fixture();
		// Attached as for the terminal, with no view connected.
		f.service.start();
		const watched = fixture();
		const early = reader(watched.service);
		await settle();
		for (const g of [f, watched]) {
			g.start();
			for (const piece of tokens(30)) g.token(piece);
		}
		// No frame was made or kept before a view connected, though the events were counted as frames would be.
		expect((f.service as unknown as { replay: { frames: unknown[] } }).replay.frames).toEqual([]);
		const late = reader(f.service);
		await settle();
		expect(late[0].type).toBe("snapshot");
		expect(late[0].cursor.sequence).toBe(early.at(-1)!.cursor.sequence);
		const view = fold(late);
		expect(view.snapshot!.messages).toEqual(fold(early).snapshot!.messages);
		f.token("tail ");
		await settle();
		const append = late.at(-1);
		expect(append?.type === "event" && append.event.type === "message.delta" && append.event.block).toBeTruthy();
		f.end();
		await settle();
		expect(fold(events(late), view).snapshot!.messages).toEqual(redactData(f.service.getSnapshot().messages));
	});
});

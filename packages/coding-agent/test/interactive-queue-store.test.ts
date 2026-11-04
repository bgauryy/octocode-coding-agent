import { Container, type TUI } from "@octocodeai/octocode-tui";
import { createStore } from "zustand/vanilla";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { flushCompactionQueue, sendCarriedMessages } from "../src/modes/interactive/interactive-mode/message-queue.ts";
import { bindQueueState } from "../src/modes/interactive/state/bind-queue.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost, heldStore } from "./interactive-mode-host.ts";

type Runtime = { steering: string[]; followUp: string[]; status: "idle" | "compacting" | "retrying" };

function setup() {
	const service = createStore<Runtime>()(() => ({ steering: [], followUp: [], status: "idle" }));
	// The same read-only shape the application service exposes: no setState.
	const source = {
		getState: () => service.getState() as never,
		subscribe: (l: () => void) => service.subscribe(() => l()),
	};
	const requestRender = vi.fn();
	// The session's whole queues; the service state only previews the last ten of each.
	const whole: { steering?: string[]; followUp?: string[] } = {};
	const host = createFakeHost({
		session: {
			getSteeringMessages: () => whole.steering ?? service.getState().steering,
			getFollowUpMessages: () => whole.followUp ?? service.getState().followUp,
		} as never,
		uiStore: heldStore(),
		ui: { requestRender } as unknown as TUI,
		pendingMessagesContainer: new Container(),
		getAppKeyDisplay: () => "alt+up",
	});
	const stop = bindQueueState(host, source);
	const rows = () => host.pendingMessagesContainer.render(100).map(stripAnsi).join("\n");
	return { service, host, requestRender, rows, stop, whole };
}

describe("queue state binding", () => {
	beforeAll(() => initTheme("dark"));

	it("draws the service queues with one frame request per change and none for an identical one", () => {
		const { service, requestRender, rows } = setup();
		expect(rows()).toBe("");

		service.setState({ steering: ["steer me"], followUp: ["follow me"] });
		expect(rows()).toContain("2 queued · 1 next turn · 1 after run");
		expect(rows()).toContain("Next turn: steer me");
		expect(rows()).toContain("After run: follow me");
		expect(requestRender).toHaveBeenCalledTimes(1);

		service.setState({ steering: ["steer me"], followUp: ["follow me"] });
		expect(requestRender).toHaveBeenCalledTimes(1);

		service.setState({ steering: [], followUp: [] });
		expect(rows()).toBe("");
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("lists messages the interface holds after the service's, and redraws once per held change", () => {
		const { service, host, requestRender, rows } = setup();
		service.setState({ steering: ["queued"] });
		requestRender.mockClear();

		host.uiStore.getState().holdMessage({ text: "held", mode: "steer" });
		expect(rows()).toContain("2 queued · 2 next turn");
		expect(rows().indexOf("queued")).toBeLessThan(rows().indexOf("held"));
		expect(requestRender).toHaveBeenCalledTimes(1);

		expect(host.uiStore.getState().takeHeldMessages()).toEqual([{ text: "held", mode: "steer" }]);
		expect(host.uiStore.getState().takeHeldMessages()).toEqual([]);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("counts and lists the whole session queue, not the service's ten previews", () => {
		const { service, rows, whole } = setup();
		const all = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
		whole.steering = all;
		service.setState({ steering: all.slice(-10) });
		expect(rows()).toContain("12 queued · 12 next turn");
		expect(rows()).toContain("1. Next turn: m1");
		expect(rows()).toContain("… 9 more queued");

		// Identical texts leave the preview unchanged, yet the count must follow.
		whole.steering = [...all, "m12"];
		service.setState({ steering: [...service.getState().steering] });
		expect(rows()).toContain("13 queued · 13 next turn");
	});

	it("offers Enter only for messages carried over a session switch, and takes carried and compaction ones apart", () => {
		const { host, rows } = setup();
		const store = host.uiStore.getState();
		store.holdMessage({ text: "typed", mode: "steer" });
		expect(rows()).not.toContain("Enter sends");
		store.holdMessage({ text: "carried", mode: "followUp", carried: true });
		expect(rows()).toContain("Enter sends");

		expect(store.takeHeldMessages(false)).toEqual([{ text: "typed", mode: "steer" }]);
		expect(host.uiStore.getState().queue.compaction).toEqual([{ text: "carried", mode: "followUp", carried: true }]);
		expect(store.takeHeldMessages(false)).toEqual([]);
		expect(store.takeHeldMessages(true)).toHaveLength(1);
		expect(rows()).toBe("");
	});

	it("names the wait for compaction from the service status", () => {
		const { service, rows } = setup();
		service.setState({ steering: ["a"] });
		expect(rows()).not.toContain("waiting for compaction");
		service.setState({ status: "compacting" });
		expect(rows()).toContain("waiting for compaction");
	});

	it("shows a queue that already holds messages when it binds, and stops after unbinding", () => {
		const { service, host, requestRender, rows, stop } = setup();
		stop();
		service.setState({ steering: ["late"] });
		const again = bindQueueState(host, {
			getState: () => service.getState() as never,
			subscribe: (l) => service.subscribe(() => l()),
		});
		expect(rows()).toContain("Next turn: late");
		expect(requestRender).not.toHaveBeenCalled();
		again();
	});
});

describe("messages carried over a session switch", () => {
	const fixture = (isCompacting = false) => ({
		uiStore: heldStore([
			{ text: "typed", mode: "steer" },
			{ text: "carried steer", mode: "steer", carried: true },
			{ text: "carried follow", mode: "followUp", carried: true },
		]),
		session: { isCompacting, prompt: vi.fn().mockResolvedValue(undefined), followUp: vi.fn(), steer: vi.fn() },
		isExtensionCommand: () => false,
		showError: vi.fn(),
		showStatus: vi.fn(),
	});
	const texts = (ui: ReturnType<typeof fixture>) => ui.uiStore.getState().queue.compaction.map((m) => m.text);

	it("are left alone by a compaction flush, which sends only what was typed during compaction", async () => {
		const ui = fixture();
		await flushCompactionQueue(createFakeHost(ui), { willRetry: true });
		expect(ui.session.steer).toHaveBeenCalledWith("typed", undefined, { attachImagePaths: true });
		expect(ui.session.steer).toHaveBeenCalledTimes(1);
		expect(texts(ui)).toEqual(["carried steer", "carried follow"]);
	});

	it("are sent in order and by kind on request, leaving compaction-held messages", async () => {
		const ui = fixture();
		await sendCarriedMessages(createFakeHost(ui));
		expect(ui.session.prompt).toHaveBeenCalledWith(
			"carried steer",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
		expect(texts(ui)).toEqual(["typed"]);
	});

	it("wait while compaction runs", async () => {
		const ui = fixture(true);
		await sendCarriedMessages(createFakeHost(ui));
		expect(ui.session.prompt).not.toHaveBeenCalled();
		expect(ui.showStatus).toHaveBeenCalled();
		expect(texts(ui)).toHaveLength(3);
	});
});

import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { AgentInterruptedEvent } from "../src/core/features/types.ts";
import { createHarness } from "./suite/harness.ts";
import { testFeatures } from "./helpers/features.ts";

it.each(["interrupted", "internal", "replacement", "shutdown"] as const)(
	"latches first active abort reason %s and records before observation",
	async (reason) => {
		let started!: () => void;
		const entered = new Promise<void>((resolve) => (started = resolve));
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const seen: AgentInterruptedEvent[] = [];
		let durable = false;
		const h = await createHarness({
			settings: { retry: { enabled: false } },
			tools: [
				{
					name: "hold",
					label: "hold",
					description: "wait",
					parameters: Type.Object({}),
					execute: async () => {
						started();
						await held;
						return {
							content: [{ type: "text", text: "released" }],
							details: {},
						};
					},
				},
			],
			features: testFeatures([
				(api) => {
					api.bus.on("agent_interrupted", async (event, ctx) => {
						seen.push(event);
						durable = ctx.sessionManager
							.getEntries()
							.some((entry) => entry.type === "message" && entry.message.role === "toolResult");
						await h.session.abort();
					});
				},
			]),
		});
		try {
			await h.session.bindFeatures({});
			h.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], {
					stopReason: "toolUse",
				}),
			]);
			const prompt = h.session.prompt("work");
			await entered;
			const turn = h.session.getTurnId();
			const first = h.session.abort(reason);
			const second = h.session.abort(reason === "interrupted" ? "replacement" : "interrupted");
			release();
			await Promise.all([prompt, first, second]);
			await h.session.abort();
			expect(seen).toHaveLength(reason === "interrupted" ? 1 : 0);
			if (reason === "interrupted") {
				expect(seen[0]?.turnId).toBe(turn);
				expect(durable).toBe(true);
			}
			expect(h.session.getTurnId()).toBeUndefined();
		} finally {
			release();
			h.cleanup();
		}
	},
	10000,
);

it("keeps external abort callers waiting while allowing the interruption observer to abort reentrantly", async () => {
	let started!: () => void;
	const entered = new Promise<void>((resolve) => (started = resolve));
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	let observing!: () => void;
	const observingPromise = new Promise<void>((resolve) => (observing = resolve));
	let releaseObserver!: () => void;
	const observerHeld = new Promise<void>((resolve) => (releaseObserver = resolve));
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		tools: [
			{
				name: "hold",
				label: "hold",
				description: "wait",
				parameters: Type.Object({}),
				execute: async () => {
					started();
					await held;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
		features: testFeatures([
			(api) => {
				api.bus.on("agent_interrupted", async () => {
					await h.session.abort();
					observing();
					await observerHeld;
				});
			},
		]),
	});
	try {
		await h.session.bindFeatures({});
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], {
				stopReason: "toolUse",
			}),
		]);
		const prompt = h.session.prompt("work");
		await entered;
		const first = h.session.abort();
		release();
		await observingPromise;
		let returned = false;
		const external = h.session.abort().then(() => {
			returned = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(returned).toBe(false);
		releaseObserver();
		await Promise.all([prompt, first, external]);
	} finally {
		release();
		releaseObserver();
		h.cleanup();
	}
}, 10000);

it("saves pending records before observing interruption when preparation fails", async () => {
	const seen: string[] = [];
	const h = await createHarness({
		features: testFeatures([
			(api) => {
				api.bus.on("agent_interrupted", (_event, ctx) => {
					for (const entry of ctx.sessionManager.getEntries())
						if (entry.type === "custom_message") seen.push(entry.customType);
				});
			},
		]),
	});
	try {
		await h.session.bindFeatures({});
		let abort: Promise<void> | undefined;
		vi.spyOn(h.session as unknown as { _prepareRun(): Promise<never> }, "_prepareRun").mockImplementation(async () => {
			await h.session.sendCustomMessage(
				{ customType: "pending-preparation", content: "saved", display: false },
				{ triggerTurn: false },
			);
			abort = h.session.abort();
			throw new Error("preparation failed");
		});
		await expect(h.session.prompt("work")).rejects.toThrow("preparation failed");
		await abort;
		expect(seen).toEqual(["pending-preparation"]);
		expect(h.session.getTurnId()).toBeUndefined();
	} finally {
		vi.restoreAllMocks();
		h.cleanup();
	}
});

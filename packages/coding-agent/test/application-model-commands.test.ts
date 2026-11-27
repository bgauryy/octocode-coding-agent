import type { ApplicationCommand, ApplicationEvent } from "@octocodeai/octocode-contracts";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { getApplicationPort } from "../src/core/application/index.ts";
import { providerQuotas } from "../src/core/model-runtime/quota-request.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function setup() {
	const cost = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };
	const harness = await createHarness({
		models: [
			{ id: "one", reasoning: true, cost },
			{ id: "plain", reasoning: false, cost },
		],
	});
	harnesses.push(harness);
	const application = getApplicationPort(harness.session);
	const events: ApplicationEvent[] = [];
	application.subscribe((event) => events.push(event));
	let next = 0;
	/** Run one command to its completed or failed receipt. */
	const run = async (
		command: { action: "setModel"; provider: string; modelId: string } | { action: "setThinking"; level: string },
	) => {
		const id = `command-${next++}`;
		await application.execute({ id, sessionId: harness.session.sessionId, ...command } as ApplicationCommand);
		await vi.waitFor(() =>
			expect(application.getSnapshot().receipts.find((receipt) => receipt.id === id)?.status).not.toBe("accepted"),
		);
		return application.getSnapshot().receipts.find((receipt) => receipt.id === id)!;
	};
	return { harness, application, events, run };
}

it("advertises the model commands and lists the models setModel accepts, with price, billing and kind", async () => {
	const { harness, application } = await setup();
	const snapshot = application.getSnapshot();
	// The provider's kind is the word the terminal footer shows beside the model.
	const kind = harness.session.modelRuntime.getProviderKind("faux");
	expect(snapshot.model?.kind).toBe(kind);
	expect(snapshot.models?.every((option) => option.kind === kind)).toBe(true);
	expect(snapshot.capabilities).toEqual(expect.arrayContaining(["setModel", "setThinking"]));
	expect(snapshot.model).toMatchObject({ provider: "faux", id: "one", billing: "metered" });
	expect(snapshot.model?.thinkingLevels).toContain("high");
	expect(snapshot.models).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ provider: "faux", id: "one", billing: "metered", cost: { input: 3, output: 15 } }),
			expect.objectContaining({ provider: "faux", id: "plain", billing: "metered" }),
		]),
	);
});

it("setModel switches the session model and the snapshot follows before the receipt completes", async () => {
	const { harness, application, events, run } = await setup();
	expect(await run({ action: "setModel", provider: "faux", modelId: "plain" })).toMatchObject({ status: "completed" });
	expect(harness.session.model?.id).toBe("plain");
	expect(application.getSnapshot().model).toMatchObject({
		provider: "faux",
		id: "plain",
		thinkingLevel: "off",
		thinkingLevels: ["off"],
	});
	const changed = events.findIndex((event) => event.type === "session.model" && event.model?.id === "plain");
	const completed = events.findIndex(
		(event) => event.type === "command.receipt" && event.receipt.status === "completed",
	);
	expect(changed).toBeGreaterThanOrEqual(0);
	expect(changed).toBeLessThan(completed);
});

it("fails setModel for a model the session does not list and keeps the current one", async () => {
	const { harness, run } = await setup();
	const receipt = await run({ action: "setModel", provider: "faux", modelId: "missing" });
	expect(receipt).toMatchObject({
		status: "failed",
		message: expect.stringContaining("Model not found: faux/missing"),
	});
	expect(harness.session.model?.id).toBe("one");
});

it("setThinking clamps to the model's levels and publishes the effective level", async () => {
	const { harness, application, run } = await setup();
	expect(await run({ action: "setThinking", level: "low" })).toMatchObject({ status: "completed" });
	expect(application.getSnapshot().model?.thinkingLevel).toBe("low");
	expect(await run({ action: "setThinking", level: "max" })).toMatchObject({ status: "completed" });
	expect(harness.session.thinkingLevel).toBe("high");
	expect(application.getSnapshot().model?.thinkingLevel).toBe("high");
	await expect(
		application.execute({
			id: "bad-level",
			sessionId: harness.session.sessionId,
			action: "setThinking",
			level: "extreme",
		} as unknown as ApplicationCommand),
	).rejects.toThrow("Invalid application command");
});

it("publishes spend with money apart from plan estimates and counts unpriced replies", async () => {
	const { harness, application } = await setup();
	const spend = (total: number) => ({
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
	});
	vi.spyOn(harness.session.modelRuntime, "getProviderBilling").mockImplementation((provider) =>
		provider === "plan-provider" ? "plan" : "metered",
	);
	harness.sessionManager.appendUsage("side_question", "faux", "one", spend(1.24));
	harness.sessionManager.appendUsage("side_question", "plan-provider", "x", spend(3.1));
	// The faux reply spends tokens at no price: one unpriced reply.
	harness.setResponses([fauxAssistantMessage("done")]);
	await harness.session.prompt("hello");
	await harness.session.waitForIdle();
	const usage = application.getSnapshot().usage;
	expect(usage).toMatchObject({ metered: 1.24, planEstimate: 3.1, unpriced: 1 });
	expect(usage?.contextPercent).toBeGreaterThan(0);
	// The window and the compaction point the footer's gauge reads, from the same measure.
	const context = harness.session.getContextUsage();
	expect(usage?.contextWindow).toBe(context?.contextWindow);
	expect(usage?.compactAt).toBe(context?.compactionThreshold);
});

it("marks a failed reply whose credential was refused, so a client can point at the provider settings", async () => {
	const { application } = await setup();
	const failed = (errorMessage: string) => ({
		role: "assistant",
		content: [],
		provider: "faux",
		model: "one",
		stopReason: "error",
		errorMessage,
		timestamp: 1,
	});
	expect(application.normalizeMessage(failed("401 invalid x-api-key"))).toMatchObject({ errorKind: "credential" });
	expect(application.normalizeMessage(failed("Overloaded, try again"))).not.toHaveProperty("errorKind");
});

it("publishes the quota windows of the session's providers when a reply ends, read once per reply, not per chunk", async () => {
	const { harness, application, events } = await setup();
	const reading = (provider: string, usedFraction: number) => ({
		provider,
		window: "primary",
		label: "5h",
		usedFraction,
		resetsAt: Date.now() + 3_600_000,
		kind: "plan" as const,
		source: "header" as const,
		observedAt: Date.now(),
	});
	let readings = [reading("faux", 0.5), reading("elsewhere", 0.99)];
	const all = vi.spyOn(providerQuotas, "all").mockImplementation(() => readings);
	vi.spyOn(providerQuotas, "providers").mockReturnValue([]);
	readings = [reading("faux", 0.82), reading("elsewhere", 0.99)];
	all.mockClear();
	harness.setResponses([fauxAssistantMessage("a long streamed answer ".repeat(40))]);
	await harness.session.prompt("hello");
	await harness.session.waitForIdle();
	// Only the session's provider (its replies and selected model), not another provider this machine saw.
	expect(application.getSnapshot().quota).toEqual([expect.objectContaining({ provider: "faux", usedFraction: 0.82 })]);
	expect(events.filter((event) => event.type === "session.quota").length).toBeGreaterThan(0);
	// The reply's end and the settle; a streamed chunk never reads the store.
	expect(all.mock.calls.length).toBeLessThanOrEqual(3);
	all.mockRestore();
});

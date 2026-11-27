import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { SessionContextCapacity } from "../src/core/agent-session/context-capacity.ts";
import type { SessionInternals } from "../src/core/agent-session/host.ts";

const model: Model<string> = {
	id: "alias",
	provider: "provider",
	api: "observed-api",
	name: "Alias",
	baseUrl: "http://fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};
const receipt = (capacity: number, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	content: [],
	usage: { ...createEmptyUsage(), contextWindow: capacity },
	stopReason: "stop",
	timestamp: 100,
	...extra,
});

function fixture(options: { configured?: boolean; selected?: Model<string>; budget?: number | "full" } = {}) {
	let id = "session-one";
	const state = { model: options.selected ?? model };
	const emit = vi.fn();
	const session = {
		get model() {
			return state.model;
		},
		agent: { state },
		isIdle: true,
		isCompacting: false,
		sessionManager: { getSessionId: () => id },
		settingsManager: { getContextBudget: () => options.budget ?? 300_000 },
		modelRuntime: { getModel: () => model, hasContextWindowOverride: () => options.configured ?? false },
	};
	const control = new SessionContextCapacity({ session, emit } as unknown as Pick<
		SessionInternals,
		"session" | "emit"
	>);
	state.model = control.select(state.model);
	return {
		state,
		control,
		emit,
		nextSession: () => {
			id = "session-two";
			state.model = control.select(model);
		},
	};
}

describe("observed context capacity", () => {
	it("refines the fallback before applying the working budget, leaving catalog/output limits intact", () => {
		const f = fixture();
		expect(f.state.model.contextWindow).toBe(180_000);
		f.control.observe(receipt(1_000_000));
		expect(f.control.limit()).toBe(1_000_000);
		expect(f.state.model.contextWindow).toBe(300_000);
		expect(f.state.model.maxTokens).toBe(64_000);
		expect(model.contextWindow).toBe(200_000);
		expect(f.emit).toHaveBeenCalledWith({ type: "session_context_changed" });
	});

	it("preserves a full-budget choice and later explicit session budgets", () => {
		const f = fixture({ budget: "full" });
		f.control.observe(receipt(1_000_000));
		expect(f.state.model.contextWindow).toBe(1_000_000);
		f.control.set(64_000);
		f.control.observe(receipt(500_000, { timestamp: 101 }));
		expect(f.state.model.contextWindow).toBe(64_000);
		expect(f.control.set()).toBe(500_000);
	});

	it.each(["configured", "sdk"])("preserves an explicit %s capacity", (kind) => {
		const f = fixture(
			kind === "configured" ? { configured: true } : { selected: { ...model, contextWindow: 400_000 } },
		);
		f.control.observe(receipt(1_000_000));
		expect(f.control.limit()).toBe(kind === "configured" ? 200_000 : 400_000);
	});

	it.each([0, -1, Infinity, NaN])("ignores invalid capacity %s", (value) => {
		const f = fixture();
		f.control.observe(receipt(value));
		expect(f.control.limit()).toBe(200_000);
	});

	it.each([
		{ stopReason: "aborted" },
		{ stopReason: "error" },
		{ provider: "other" },
		{ model: "other" },
		{ api: "other" },
	] as const)("ignores an inapplicable receipt %j", (extra) => {
		const f = fixture();
		f.control.observe(receipt(1_000_000, extra));
		expect(f.control.limit()).toBe(200_000);
	});

	it("ignores stale receipts and forgets observations and budgets in a new session", () => {
		const f = fixture();
		f.control.observe(receipt(1_000_000));
		f.control.observe(receipt(50_000, { timestamp: 99 }));
		expect(f.control.limit()).toBe(1_000_000);
		f.control.set(32_000);
		f.nextSession();
		expect(f.control.limit()).toBe(200_000);
		expect(f.state.model.contextWindow).toBe(180_000);
	});
});

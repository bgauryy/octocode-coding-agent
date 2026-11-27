/** @vitest-environment jsdom */
import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { ApplicationProjection } from "@octocodeai/octocode-projections";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { SessionComposer } from "../src/app/live/SessionComposer.tsx";
import { contextText, quotaWarnings, resetClock, sigmaText } from "../src/app/live/usage-text.ts";
import { controlView, posted, setupControls } from "./control-fixtures.tsx";
import { FakeSocket } from "./helpers.ts";

beforeEach(setupControls);
afterEach(() => vi.unstubAllGlobals());

const CONTROL = ["prompt", "steer", "followUp", "abort"] as const;
const model = {
	provider: "anthropic",
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	input: ["text", "image"] as ("text" | "image")[],
	thinkingLevel: "medium" as const,
	thinkingLevels: ["off", "low", "medium", "high"] as ("off" | "low" | "medium" | "high")[],
	billing: "plan" as const,
};
const models = [
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", billing: "plan" as const },
	{
		provider: "openai",
		id: "gpt-6.1",
		name: "GPT-6.1",
		billing: "metered" as const,
		cost: { input: 2, output: 8 },
	},
	{ provider: "openai", id: "gpt-6.1-mini", name: "GPT-6.1 mini", billing: "metered" as const },
];

async function composer(overrides: Partial<ApplicationSnapshot>) {
	const view = controlView(<SessionComposer />);
	await view.workspace();
	await view.session(overrides);
	return view;
}

it("shows the model chip and thinking select only when the host advertises their commands", async () => {
	const view = await composer({ capabilities: [...CONTROL], model, models });
	expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
	expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
	await view.session({ capabilities: [...CONTROL, "setModel"], model, models });
	expect(screen.getByRole("button", { name: /^Model: Claude Opus 5\.5/ })).toBeInTheDocument();
	expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
	await view.session({ capabilities: [...CONTROL, "setModel", "setThinking"], model, models });
	const thinking = screen.getByRole("combobox", { name: "Thinking" });
	expect(
		within(thinking)
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["off", "low", "medium", "high"]);
	// A view-only link carries no capabilities: no controls.
	await view.session({ capabilities: [], model, models });
	expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
});

it("sends setModel for the model picked from the searchable list, grouped by provider with price and billing", async () => {
	const view = await composer({ capabilities: [...CONTROL, "setModel"], model, models });
	await userEvent.click(screen.getByRole("button", { name: /^Model:/ }));
	const openai = screen.getByRole("region", { name: "openai" });
	expect(within(openai).getByRole("button", { name: "GPT-6.1 (gpt-6.1), $2 / $8 per M, per token" })).toBeTruthy();
	expect(screen.getByRole("region", { name: "anthropic" })).toHaveTextContent("plan");
	await userEvent.type(screen.getByRole("searchbox", { name: "Search models" }), "mini");
	expect(screen.queryByRole("region", { name: "anthropic" })).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: /^GPT-6\.1 mini \(gpt-6\.1-mini\), no price/ }));
	expect(posted().at(-1)).toMatchObject({
		sessionId: "s",
		action: "setModel",
		provider: "openai",
		modelId: "gpt-6.1-mini",
	});
	expect(screen.queryByRole("searchbox", { name: "Search models" })).toBeNull();
	expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
	// The host refuses the switch: its reason shows and the chip is usable again.
	const id = posted().at(-1).id;
	const reason = "Model not found: openai/gpt-6.1-mini. Choose one the session lists.";
	await view.session({
		capabilities: [...CONTROL, "setModel"],
		model,
		models,
		receipts: [{ id, status: "failed", message: reason }],
	});
	expect(screen.getByRole("alert")).toHaveTextContent(reason);
	expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled();
});

it("sends setThinking with a level the model offers", async () => {
	await composer({ capabilities: [...CONTROL, "setThinking"], model, models });
	await userEvent.selectOptions(screen.getByRole("combobox", { name: "Thinking" }), "high");
	expect(posted().at(-1)).toMatchObject({ action: "setThinking", level: "high" });
});

it("shows context, spend split by who pays and a plan quota warning under the composer", async () => {
	await composer({
		capabilities: [...CONTROL],
		usage: { metered: 1.24, planEstimate: 3.1, unpriced: 0, contextPercent: 41.6 },
		quota: [
			{
				provider: "openai-codex",
				window: "primary",
				label: "5h",
				usedFraction: 0.92,
				kind: "plan",
				source: "header",
				observedAt: 1,
			},
			{
				provider: "openai",
				window: "requests",
				label: "requests",
				usedFraction: 0.95,
				kind: "rate",
				source: "header",
				observedAt: 1,
			},
		],
	});
	const strip = screen.getByRole("region", { name: "Session usage" });
	expect(strip).toHaveTextContent("Context 42%");
	expect(strip).toHaveTextContent("Σ ≈$1.24 · ~$3.10 plan");
	// Another provider than the selected model's is named; the footer's words otherwise (`quota 5h 92%`).
	expect(strip).toHaveTextContent("openai-codex quota 5h 92%");
	expect(strip).not.toHaveTextContent("requests");
});

it("leaves out Σ while nothing was spent and a plan window whose reset has passed", async () => {
	const window = { provider: "openai-codex", label: "5h", kind: "plan", source: "header", observedAt: 1 } as const;
	await composer({
		capabilities: [...CONTROL],
		usage: { metered: 0, planEstimate: 0, unpriced: 0, contextPercent: 3 },
		quota: [
			{ ...window, window: "primary", usedFraction: 0.95, resetsAt: Date.now() - 60_000 },
			{ ...window, window: "secondary", label: "week", usedFraction: 0.75, resetsAt: Date.now() + 3_600_000 },
		],
	});
	const strip = screen.getByRole("region", { name: "Session usage" });
	expect(strip).toHaveTextContent("Context 3%");
	expect(strip).not.toHaveTextContent("Σ");
	expect(strip).not.toHaveTextContent("95%");
	expect(strip).toHaveTextContent(/openai-codex quota week 75% · resets \d\d:\d\d/);
});

it("reads the context as the footer's gauge does: of which window, and its alarm from where Octocode compacts", () => {
	const usage = { metered: 0, planEstimate: 0, unpriced: 0 };
	expect(contextText(usage)).toBeUndefined();
	expect(contextText({ ...usage, contextPercent: 0.3, contextWindow: 115_000 })).toEqual({
		text: "Context <1% of 115k",
	});
	expect(contextText({ ...usage, contextPercent: 41.6 })).toEqual({ text: "Context 42%" });
	expect(contextText({ ...usage, contextPercent: 55, contextWindow: 1_000_000 })).toEqual({
		text: "Context 55% of 1M",
		tone: "warning",
	});
	// Compaction at 100k of 200k: red past 40 % of the window, as the footer turns red past 80 % of the compact point.
	const compacting = { ...usage, contextWindow: 200_000, compactAt: 100_000 };
	expect(contextText({ ...compacting, contextPercent: 41 })?.tone).toBe("danger");
	expect(contextText({ ...compacting, contextPercent: 39 })?.tone).toBeUndefined();
});

// Contract change: the web wrote `Σ $1.24` and `+ 2 unpriced` while the footer writes `Σ ≈$1.24` and `+ n/a`; both now
// write the footer's words (`octocode/ui/footer/parts.ts` `sigmaText`, `shared/format.ts` `formatCost`).
it("writes spend as the footer does: money only, plan only, mixed, unpriced, nothing", () => {
	expect(sigmaText({ metered: 1.24, planEstimate: 0, unpriced: 0 })).toBe("Σ ≈$1.24");
	expect(sigmaText({ metered: 0.004, planEstimate: 0, unpriced: 0 })).toBe("Σ ≈$<0.01");
	expect(sigmaText({ metered: 0, planEstimate: 3.1, unpriced: 0 })).toBe("Σ ~$3.10 plan");
	expect(sigmaText({ metered: 1.24, planEstimate: 3.1, unpriced: 0 })).toBe("Σ ≈$1.24 · ~$3.10 plan");
	expect(sigmaText({ metered: 0.004, planEstimate: 0, unpriced: 2 })).toBe("Σ ≈$<0.01 + n/a");
	expect(sigmaText({ metered: 0, planEstimate: 0.5, unpriced: 1 })).toBe("Σ cost n/a · ~$0.50 plan");
	expect(sigmaText({ metered: 0, planEstimate: 0, unpriced: 1 })).toBe("Σ cost n/a");
	expect(sigmaText({ metered: 0, planEstimate: 0, unpriced: 0 })).toBeUndefined();
	expect(resetClock(Date.UTC(2026, 10, 30, 9), Date.UTC(2026, 10, 23, 9))).toMatch(/^[A-Z][a-z]{2} \d+$/);
	// The selected model's provider in the footer's words, without its name.
	const now = Date.UTC(2026, 10, 23, 9);
	const reading = { provider: "faux", window: "primary", label: "5h", kind: "plan", source: "header" } as const;
	const resetsAt = now + 3_600_000;
	expect(quotaWarnings([{ ...reading, usedFraction: 0.82, resetsAt, observedAt: now }], "faux", now)).toEqual([
		{ key: "faux:primary", text: `quota 5h 82% · resets ${resetClock(resetsAt, now)}`, tone: "warning" },
	]);
});

it("names the provider as the footer does and sends a session without a model to the provider settings", async () => {
	const view = await composer({
		capabilities: [...CONTROL, "setModel"],
		model: { ...model, billing: "metered", kind: "local" },
		models: [{ ...models[1], kind: "local" }],
	});
	expect(screen.getByRole("button", { name: /^Model: Claude Opus 5\.5/ })).toHaveTextContent("· local");
	await userEvent.click(screen.getByRole("button", { name: /^Model:/ }));
	expect(screen.getByRole("button", { name: "GPT-6.1 (gpt-6.1), $2 / $8 per M, local" })).toBeTruthy();
	await view.session({ capabilities: [...CONTROL, "setModel"], model: undefined, models: [] });
	expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
	expect(screen.getByRole("link", { name: /^No model/ })).toHaveAttribute("href", "#settings?section=providers");
	expect(document.body).not.toHaveTextContent("unknown");
});

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}

it("shows a reply's usage as a line and links a credential error to Settings → Providers", () => {
	vi.stubGlobal("WebSocket", FakeSocket);
	const [event] = new ApplicationProjection().update(
		{
			sessionId: "s",
			messages: [
				{
					id: "m",
					role: "assistant",
					text: "",
					complete: true,
					status: "failed",
					provider: "openai",
					model: "gpt-6.1",
					errorMessage: "openai/gpt-6.1: 401 invalid api key\nFix: /providers → OpenAI",
					errorKind: "credential",
					usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 0, cost: { total: 0.0123 } },
				},
			],
			streaming: false,
			steering: [],
			followUp: [],
			receipts: [],
			capabilities: [],
		},
		1,
	);
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	expect(screen.getByText("Usage: 1.2k in · 0.3k out · 0.9k cached · $0.01")).toBeInTheDocument();
	expect(screen.queryByText(/"cacheRead"/)).toBeNull();
	expect(screen.getByRole("link", { name: /Settings → Providers/ })).toHaveAttribute(
		"href",
		"#settings?section=providers",
	);
});

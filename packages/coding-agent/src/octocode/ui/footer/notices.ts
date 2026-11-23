import { fallbackNotice } from "../../../core/agent-session/fallback-switch.ts";
import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { notify } from "../../shared/commands.ts";
import { modelLookup, unpricedModel } from "../../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Says once per session, as a warning, that a reply came from a model without pricing: the cost shown leaves its usage
 * out (the displays mark it `n/a`). Not only in the TUI: an RPC client shows notifications too.
 */
export function registerUnpricedNotice(api: FeatureSetup): void {
	let warned = false;
	api.bus.on("session_start", async () => {
		warned = false;
	});
	api.bus.on("message_end", async (event, ctx) => {
		if (warned || !ctx.hasUI || event.message.role !== "assistant") return;
		const model = unpricedModel(event.message, modelLookup(ctx));
		if (!model) return;
		warned = true;
		notify(ctx.ui, `${model} has no pricing in models.json; its usage is not in the cost`, "warning");
	});
}

type ModelInfo = Pick<NonNullable<FeatureContext["model"]>, "provider" | "id" | "reasoning" | "compat">;

/** A model of another provider with the same id that declares `reasoning` (a built-in one, for a `models.json` copy that left it out). */
export function reasoningTwin(model: ModelInfo, all: readonly ModelInfo[]): ModelInfo | undefined {
	if (model.reasoning) return undefined;
	return all.find((other) => other.id === model.id && other.provider !== model.provider && other.reasoning);
}

/** `retry.fallbackModels` replaced a failed model: say so and why, since the session model changed by itself, and name
 * a change between plan and per-token billing. Interactive and RPC clients see this notification; print mode has no UI
 * and reads the run outcome warning instead (`retry-fallback.ts`), which `fallbackNotice` words the same way, so each
 * surface shows the notice once. */
export function registerFallbackNotice(api: FeatureSetup): void {
	api.bus.on("model_select", async (event, ctx) => {
		if (event.source !== "fallback" || !ctx.hasUI) return;
		const previous = event.previousModel;
		const billing = (provider: string) => ctx.modelRegistry.getProviderBilling(provider);
		const text = fallbackNotice({
			from: previous ? `${previous.provider}/${previous.id}` : "The model",
			to: `${event.model.provider}/${event.model.id}`,
			reason: event.reason ?? "hit a usage limit",
			billing: { from: billing(previous?.provider ?? event.model.provider), to: billing(event.model.provider) },
		});
		notify(ctx.ui, text, "warning");
	});
}

/**
 * Says once per model and session when the model declares no `reasoning` but a model with its id does: Octocode then never
 * asks it to think, so there are no thinking blocks, no thinking level, and no thought on the working line.
 */
export function registerReasoningNotice(api: FeatureSetup): void {
	const warned = new Set<string>();
	const check = async (_event: unknown, ctx: FeatureContext) => {
		const model = ctx.model;
		if (!ctx.hasUI || !model) return;
		const key = `${model.provider}/${model.id}`;
		if (warned.has(key)) return;
		const twin = reasoningTwin(model, ctx.modelRegistry?.getAll?.() ?? []);
		if (!twin) return;
		warned.add(key);
		const compat: unknown = twin.compat;
		const adaptive = isRecord(compat) && compat.forceAdaptiveThinking === true;
		const fields = `"reasoning": true${adaptive ? ' and "compat": { "forceAdaptiveThinking": true }' : ""}`;
		notify(
			ctx.ui,
			`${key} does not declare reasoning in models.json, so Octocode never asks it to think. ${twin.provider}/${twin.id} declares it: add ${fields} to its entry.`,
			"warning",
		);
	};
	api.bus.on("session_start", async (event, ctx) => {
		warned.clear();
		await check(event, ctx);
	});
	api.bus.on("model_select", check);
}

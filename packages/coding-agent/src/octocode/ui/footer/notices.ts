import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/index.ts";
import { notify } from "../../shared/commands.ts";
import { modelLookup, unpricedModel } from "../../shared/util.ts";
import { isRecord } from "../../../utils/guards.ts";

/**
 * Says once per session, as a warning, that a reply came from a model without pricing: the cost shown leaves its usage
 * out (the displays mark it `n/a`). Not only in the TUI: an RPC client shows notifications too.
 */
export function registerUnpricedNotice(api: ExtensionAPI): void {
	let warned = false;
	api.on("session_start", async () => {
		warned = false;
	});
	api.on("message_end", async (event, ctx) => {
		if (warned || !ctx.hasUI || event.message.role !== "assistant") return;
		const model = unpricedModel(event.message, modelLookup(ctx));
		if (!model) return;
		warned = true;
		notify(ctx.ui, `${model} has no pricing in models.json; its usage is not in the cost`, "warning");
	});
}

type ModelInfo = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id" | "reasoning" | "compat">;

/** A model of another provider with the same id that declares `reasoning` (a built-in one, for a `models.json` copy that left it out). */
export function reasoningTwin(model: ModelInfo, all: readonly ModelInfo[]): ModelInfo | undefined {
	if (model.reasoning) return undefined;
	return all.find((other) => other.id === model.id && other.provider !== model.provider && other.reasoning);
}

/**
 * Says once per model and session when the model declares no `reasoning` but a model with its id does: Octocode then never
 * asks it to think, so there are no thinking blocks, no thinking level, and no thought on the working line.
 */
export function registerReasoningNotice(api: ExtensionAPI): void {
	const warned = new Set<string>();
	const check = async (_event: unknown, ctx: ExtensionContext) => {
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
	api.on("session_start", async (event, ctx) => {
		warned.clear();
		await check(event, ctx);
	});
	api.on("model_select", check);
}

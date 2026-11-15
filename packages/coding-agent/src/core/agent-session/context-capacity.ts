import type { AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import { isVirtualModel } from "../virtual-models.ts";
import type { SessionInternals } from "./host.ts";

/** The configured working budget keeps a tokenizer margin, unless the user explicitly requests the full capacity. */
export function workingContextTokens(capacity: number, setting: number | "full"): number {
	return setting === "full" ? capacity : Math.min(setting, Math.floor(capacity * 0.9));
}

const same = (a: Model<any>, b: { provider: string; model: string; api: string }) =>
	a.provider === b.provider && a.id === b.model && a.api === b.api;

/** Session-local working budgets and observed capacity; the shared provider catalog is never changed. */
export class SessionContextCapacity {
	private readonly budgets = new Map<string, number>();
	private readonly observed = new Map<string, { capacity: number; timestamp: number }>();
	private sessionId?: string;
	private selected?: Model<any>;
	private readonly host: Pick<SessionInternals, "session" | "emit">;
	constructor(host: Pick<SessionInternals, "session" | "emit">) {
		this.host = host;
	}

	private key(model: Model<any>): string {
		const id = this.host.session.sessionManager.getSessionId();
		if (id !== this.sessionId) {
			this.budgets.clear();
			this.observed.clear();
			this.sessionId = id;
		}
		return `${model.provider}/${model.id}`;
	}

	private original(model: Model<any>): Model<any> {
		return this.selected?.provider === model.provider && this.selected.id === model.id
			? this.selected
			: (this.host.session.modelRuntime.getModel(model.provider, model.id) ?? model);
	}

	private effective(model: Model<any>): Model<any> {
		const receipt = this.observed.get(this.key(model));
		const runtime = this.host.session.modelRuntime;
		const catalog = runtime.getModel(model.provider, model.id);
		const explicit =
			runtime.hasContextWindowOverride(model.provider, model.id) ||
			(catalog !== undefined && catalog.contextWindow !== model.contextWindow);
		return receipt && !explicit ? { ...model, contextWindow: receipt.capacity } : model;
	}

	private budgeted(model: Model<any>): Model<any> {
		const effective = this.effective(model);
		const chosen = this.budgets.get(this.key(model));
		const tokens =
			chosen === undefined
				? workingContextTokens(effective.contextWindow, this.host.session.settingsManager.getContextBudget())
				: Math.min(effective.contextWindow, chosen);
		return tokens < effective.contextWindow ? { ...effective, contextWindow: tokens } : effective;
	}

	select(model: Model<any>): Model<any> {
		if (isVirtualModel(model) || !(model.contextWindow > 0)) return model;
		this.selected = model;
		return this.budgeted(model);
	}

	limit(): number | undefined {
		const model = this.host.session.model;
		return model && !isVirtualModel(model) ? this.effective(this.original(model)).contextWindow : undefined;
	}

	set(tokens?: number): number {
		const { session } = this.host;
		if (!session.isIdle || session.isCompacting)
			throw new Error("Wait for the current request to finish before changing context size.");
		const model = session.model;
		const capacity = this.limit();
		if (!model || !capacity) throw new Error("Select a physical model with /model before choosing its context size.");
		const minimum = Math.min(8192, capacity);
		if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < minimum || tokens > capacity))
			throw new Error(
				`Context size must be between ${minimum.toLocaleString()} and ${capacity.toLocaleString()} tokens for ${model.provider}/${model.id}.`,
			);
		const key = this.key(model);
		if (tokens === undefined) this.budgets.delete(key);
		else this.budgets.set(key, tokens);
		// A model the catalog does not hold exists only as this definition, which the budgeted copy replaces: keep it.
		const original = this.original(model);
		this.selected = original;
		session.agent.state.model = this.budgeted(original);
		this.host.emit({ type: "session_context_changed" });
		return session.agent.state.model.contextWindow;
	}

	observe(message: AssistantMessage): void {
		const { session } = this.host;
		const model = session.model;
		const capacity = message.usage.contextWindow;
		if (
			!model ||
			isVirtualModel(model) ||
			!same(model, message) ||
			!["stop", "toolUse", "length"].includes(message.stopReason) ||
			typeof capacity !== "number" ||
			!Number.isFinite(capacity) ||
			capacity <= 0
		)
			return;
		const key = this.key(model);
		if (message.timestamp < (this.observed.get(key)?.timestamp ?? -Infinity)) return;
		this.observed.set(key, { capacity, timestamp: message.timestamp });
		session.agent.state.model = this.budgeted(this.original(model));
		this.host.emit({ type: "session_context_changed" });
	}
}

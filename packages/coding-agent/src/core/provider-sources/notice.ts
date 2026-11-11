import type { Model } from "@octocodeai/octocode-ai";
import type { ModelRuntime } from "../model-runtime.ts";

/** What a session needs for the notice: its model, the runtime that knows disabled providers, and a next-turn message. */
export interface ProviderNoticeSession {
	readonly model: Pick<Model<any>, "provider" | "id"> | undefined;
	readonly modelRuntime: Pick<ModelRuntime, "isProviderDisabled" | "getProvider">;
	sendCustomMessage(
		message: { customType: string; content: string; display: boolean },
		options: { deliverAs: "nextTurn" },
	): Promise<void>;
}

const PROVIDER_NOTICE_TYPE = "provider-disabled";

const noticed = new WeakMap<object, string>();

/**
 * Tell a session, at its next turn, that its model's provider is disabled: when it was restored on one, and when the
 * user disables one it is using. Says it once per provider until the session is on an enabled one again.
 */
export function noticeDisabledProvider(session: ProviderNoticeSession): void {
	const model = session.model;
	if (!model || !session.modelRuntime.isProviderDisabled(model.provider)) {
		noticed.delete(session);
		return;
	}
	if (noticed.get(session) === model.provider) return;
	noticed.set(session, model.provider);
	const name = session.modelRuntime.getProvider(model.provider)?.name ?? model.provider;
	void session.sendCustomMessage(
		{
			customType: PROVIDER_NOTICE_TYPE,
			content: `The provider ${name} (${model.provider}) is disabled, but this session uses ${model.provider}/${model.id}. Requests may still fail or be refused. Switch with /model, or turn the provider back on in /providers.`,
			display: true,
		},
		{ deliverAs: "nextTurn" },
	);
}

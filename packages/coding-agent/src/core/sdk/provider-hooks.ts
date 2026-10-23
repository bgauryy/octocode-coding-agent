import type { ModelsSimpleStreamOptions } from "@octocodeai/octocode-ai";
import type { ExtensionRunner } from "../extensions/index.ts";

/** Provider request, response and stream callbacks that forward to the session's extension runner once it exists. */
export function createProviderHooks(extensionRunnerRef: { current?: ExtensionRunner }): {
	transformProviderPayload: (payload: unknown) => Promise<unknown>;
	handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]>;
	handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]>;
} {
	const transformProviderPayload = async (payload: unknown) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};
	return { transformProviderPayload, handleProviderResponse, handleProviderStreamEvent };
}

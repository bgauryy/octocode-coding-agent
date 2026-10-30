import type { ModelRuntime } from "./model-runtime.ts";

/** Whether usage is paid by a subscription, so a cost figure is an estimate of API value, not a bill. */
export function billedBySubscription(runtime: Pick<ModelRuntime, "isUsingSubscription">, provider: string): boolean {
	// Kimi Coding is subscription-backed despite using API-key authentication.
	return provider === "kimi-coding" || runtime.isUsingSubscription(provider);
}

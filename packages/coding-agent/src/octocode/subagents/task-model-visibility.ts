import type { FeatureContext } from "../../core/features/index.ts";

/**
 * Whether `provider` authenticates only through this session's runtime override (`--api-key`): that key lives in this
 * process's memory and never reaches a child, which inherits the environment and the shared credential store instead.
 * The provider's own check covers saved credentials, models.json and inherited environment requirements.
 */
export function sessionOnlyProvider(registry: FeatureContext["modelRegistry"] | undefined, provider: string): boolean {
	const status = registry?.getProviderAuthStatus?.(provider);
	return status?.source === "runtime" && !status.hasInheritedAuth;
}

/** Check a parent model against the provider's own catalog for the credentials a child inherits. */
export function modelAvailableToChild(
	registry: FeatureContext["modelRegistry"] | undefined,
	model: { provider: string; id: string },
): boolean {
	return (
		!registry?.isModelAccessRejected?.(model) &&
		(registry?.isModelAvailableToChild?.(model) ?? !sessionOnlyProvider(registry, model.provider))
	);
}

/** The same user controls govern explicit models, inherited parent routes and optional catalog discovery. */
export function modelEnabled(
	registry: FeatureContext["modelRegistry"] | undefined,
	model: { provider: string; id: string },
): boolean {
	return !registry?.isProviderDisabled?.(model.provider) && !registry?.isModelHidden?.(model);
}

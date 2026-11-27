import type { FeatureSetup, ToolRegistrar } from "../../core/features/types.ts";

/** Tool members only the native composition may use; the setup refuses them for other features. */
interface NativeToolRegistrar extends ToolRegistrar {
	/** Apply an additional tool permission filter without changing the requested loadout. */
	setPolicy?(allows: (name: string) => boolean): void;
}

/** The setup as the native composition sees it. */
interface NativeFeatureSetup extends FeatureSetup {
	readonly tools: NativeToolRegistrar;
}

/** View the factory argument as the native setup. */
export function nativeHost(setup: FeatureSetup): NativeFeatureSetup {
	return setup;
}

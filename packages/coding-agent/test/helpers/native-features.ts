import type { NativeFeatureSet } from "../../src/core/resource-loader/types.ts";
import { NATIVE_FEATURES } from "../../src/main/native-features.ts";

/**
 * The native feature set the CLI passes to every session, for a test that runs with it. Kept apart from `features.ts`
 * so a test that only composes its own features does not load `octocode/`.
 */
export function nativeFeatureSet(): NativeFeatureSet {
	return NATIVE_FEATURES;
}

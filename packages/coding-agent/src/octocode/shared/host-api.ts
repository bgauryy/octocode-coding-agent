import type { ExtensionAPI } from "../../core/extensions/types.ts";

/**
 * Members only the native composition may use. They exist on the object `createExtensionAPI()` builds, but are not
 * part of the public `ExtensionAPI` contract; the loader rejects other extensions that call them.
 */
interface NativeExtensionAPI extends ExtensionAPI {
	/** Apply an additional tool permission filter without changing the requested loadout. */
	setToolPolicy?(allows: (name: string) => boolean): void;
}

/** View the factory argument as the native host API. */
export function nativeHost(pi: ExtensionAPI): NativeExtensionAPI {
	return pi;
}

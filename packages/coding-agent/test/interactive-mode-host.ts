/**
 * Fake InteractiveMode hosts for tests that drive one collaborator module directly. Like the mode's own host, the
 * fake gets every module-backed method, except the ones the test defines on it.
 */

import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { interactiveModeMethodImplementations } from "../src/modes/interactive/interactive-mode/host-methods.ts";

/** Adds the missing host methods to `fake` and returns it typed as a host. */
export function createFakeHost<T extends object>(fake: T): T & InteractiveModeHost {
	const methods = fake as Record<string, unknown>;
	for (const [name, implementation] of Object.entries(interactiveModeMethodImplementations)) {
		if (name in fake) continue;
		const call = implementation as (host: T, ...args: unknown[]) => unknown;
		methods[name] = (...args: unknown[]) => call(fake, ...args);
	}
	return fake as T & InteractiveModeHost;
}

import type { ApplicationStateSource, ApplicationStateStore } from "../state.ts";

/** The state store without `setState`: a view reads and follows what it draws but cannot write it. */
export function readOnlyApplicationState(store: ApplicationStateStore): ApplicationStateSource {
	return { getState: () => store.getState(), subscribe: (listener) => store.subscribe(() => listener()) };
}

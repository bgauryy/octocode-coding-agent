import type { ApplicationStateSource, ApplicationStateStore } from "../state.ts";

/**
 * The state store without `setState`: a view reads and follows what it draws but cannot write it. `observed` runs
 * before every read and subscription, so the service starts following its session for the view.
 */
export function readOnlyApplicationState(
	store: ApplicationStateStore,
	observed: () => void = () => undefined,
): ApplicationStateSource {
	return {
		getState: () => {
			observed();
			return store.getState();
		},
		subscribe: (listener) => {
			observed();
			return store.subscribe(() => listener());
		},
	};
}

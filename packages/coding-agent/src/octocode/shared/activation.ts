import { randomUUID } from "node:crypto";

const activations = new WeakMap<object, string>();
const dispatches = new WeakMap<object, string>();

/** One id per start dispatch, including reload/resume; repeated delivery retains the same id. */
export function activate(session: object, event: object): string {
	const id = dispatches.get(event) ?? randomUUID();
	dispatches.set(event, id);
	activations.set(session, id);
	return id;
}

export function activationId(session: object): string {
	let id = activations.get(session);
	if (!id) activations.set(session, (id = randomUUID()));
	return id;
}

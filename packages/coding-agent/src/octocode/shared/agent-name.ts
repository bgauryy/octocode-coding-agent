/**
 * This session's name on the team (`shy-barnacle`): the team sets it when the session joins and clears it when it
 * leaves; the terminal title shows it. One store per feature instance, like `runningWorkOf`.
 */
export class AgentName {
	private name: string | undefined;
	private readonly listeners = new Set<() => void>();

	get(): string | undefined {
		return this.name;
	}

	set(name: string | undefined): void {
		if (name === this.name) return;
		this.name = name;
		for (const listener of this.listeners) listener();
	}

	/** Calls `listener` after each change; returns what stops it. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

const stores = new WeakMap<object, AgentName>();
export function agentNameOf(owner: object): AgentName {
	let store = stores.get(owner);
	if (!store) {
		store = new AgentName();
		stores.set(owner, store);
	}
	return store;
}

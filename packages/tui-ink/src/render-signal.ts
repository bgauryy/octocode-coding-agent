/** A change counter that React reads through `useSyncExternalStore`: each `notify` asks subscribers to render again. */
export interface RenderSignal {
	readonly subscribe: (listener: () => void) => () => void;
	readonly version: () => number;
}

export class RenderSignalSource implements RenderSignal {
	private count = 0;
	private readonly listeners = new Set<() => void>();

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	readonly version = (): number => this.count;

	notify(): void {
		this.count += 1;
		for (const listener of this.listeners) listener();
	}
}

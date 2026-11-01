export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;

/** Listeners that see terminal input before the focused component and may consume or rewrite it. */
export class InputListeners {
	private readonly listeners = new Set<TuiInputListener>();

	add(listener: TuiInputListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	remove(listener: TuiInputListener): void {
		this.listeners.delete(listener);
	}

	/** The input after every listener ran, or undefined when a listener consumed it or left it empty. */
	filter(data: string): string | undefined {
		if (this.listeners.size === 0) return data;
		let current = data;
		for (const listener of this.listeners) {
			const result = listener(current);
			if (result?.consume) {
				return undefined;
			}
			if (result?.data !== undefined) {
				current = result.data;
			}
		}
		return current.length === 0 ? undefined : current;
	}
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;

/** Distinct input failures reported per process; a handler that throws on every key reports once. */
const MAX_REPORTED = 100;
const reported = new Set<string>();

function reportInputError(error: unknown): void {
	const key = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	if (reported.has(key) || reported.size >= MAX_REPORTED) return;
	reported.add(key);
	// Input arrives from stdin's data event, where a throw is an uncaught exception that ends the process: report it as a
	// rejection instead, which the interactive session shows as a warning.
	void Promise.reject(error);
}

/** Handle one terminal input event so a component or listener that throws loses that key, not the session. */
export function isolateInput(handle: () => void): void {
	try {
		handle();
	} catch (error) {
		reportInputError(error);
	}
}
/**
 * Sees each key before the focused component. Printable characters that arrived in one terminal read (a typed run) are
 * each seen first and reach the component together afterwards: a listener that reads the component's state (an
 * editor's text) during a run sees it as it was before the run, not with the earlier characters of the run applied.
 */
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
			let result: TuiInputListenerResult;
			try {
				result = listener(current);
			} catch (error) {
				// Report it and pass the input on unchanged, as if the listener had not seen it. The listener stays: one that
				// failed on a single event (a wheel event during a frame-drop recovery) must not stop routing every later one,
				// and one that throws on every key still lets all input, Ctrl+C included, reach the focused component.
				reportInputError(error);
				continue;
			}
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

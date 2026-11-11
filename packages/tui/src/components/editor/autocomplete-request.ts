import type { AutocompleteSuggestions } from "../../autocomplete/types.ts";

/** Release the editor's request queue when a provider ignores cancellation; still handle its eventual rejection. */
export async function untilAutocompleteAborted(
	request: Promise<AutocompleteSuggestions | null>,
	signal: AbortSignal,
): Promise<AutocompleteSuggestions | null> {
	let onAbort = () => {};
	const aborted = new Promise<null>((resolve) => {
		onAbort = () => resolve(null);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([request, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Unsent bytes a workspace socket may hold before its page counts as falling behind. */
const BUFFER_LIMIT = 1048576;
/** How long the unsent bytes may stay over the limit: a page that is reading takes a multi-megabyte frame well within it. */
const STALL_MS = 10_000;

/** When each socket was first seen over the limit; cleared once it is seen under it. */
const overSince = new WeakMap<object, number>();

/**
 * Whether the page behind `socket` stopped reading: its unsent bytes stayed over the limit for {@link STALL_MS}. A
 * frame this server has just queued (a large board's first snapshot) is still unsent on the same tick, so the size of
 * the buffer alone never ends a connection: checked between two sends, it would drop every page of a large repository
 * before its first frame arrived. Callers check before each send and end the connection when this returns true.
 */
export function readerStalled(socket: { readonly bufferedAmount: number }, now = Date.now()): boolean {
	if (socket.bufferedAmount <= BUFFER_LIMIT) {
		overSince.delete(socket);
		return false;
	}
	const since = overSince.get(socket);
	if (since === undefined) {
		overSince.set(socket, now);
		return false;
	}
	return now - since >= STALL_MS;
}

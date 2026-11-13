import diagnosticsChannel from "node:diagnostics_channel";
import module from "node:module";

/**
 * Node writes the compile cache (`module.enableCompileCache`) synchronously when the process exits: after a new
 * release or in a new checkout that is every module compiled so far, which held a cold exit for up to four seconds.
 * The write blocks the event loop, so it moves only where nobody waits on the process: one without a screen (print,
 * JSON, RPC, a subagent, whose parent waits for its exit) writes it once its first request's body has gone, while the
 * server works on the request, on the next turn of the event loop. The interactive mode keeps the write at exit: any
 * other moment could freeze a key the user types. Without the API, or when writing fails, the exit writes as before.
 */

/** Undici (fetch and the provider clients) publishes here once a request's body went out: the server has it all. */
const REQUEST_SENT = "undici:request:bodySent";

let done = false;
let listening = false;

function flush(): void {
	if (done) return;
	done = true;
	stopListening();
	setImmediate(() => {
		try {
			module.flushCompileCache?.();
		} catch {
			// The exit writes it instead.
		}
	});
}

function onRequestSent(): void {
	flush();
}

function stopListening(): void {
	if (!listening) return;
	listening = false;
	try {
		diagnosticsChannel.unsubscribe(REQUEST_SENT, onRequestSent);
	} catch {
		// Never subscribed.
	}
}

/** A process without a screen: write the compile cache once its first request is out. */
export function flushCompileCacheOnNextRequest(): void {
	if (done || listening || typeof module.flushCompileCache !== "function") return;
	try {
		diagnosticsChannel.subscribe(REQUEST_SENT, onRequestSent);
		listening = true;
	} catch {
		// The exit writes it.
	}
}

/** The interactive mode: the compile cache is written at exit, never on a request. */
export function holdCompileCacheFlush(): void {
	stopListening();
}

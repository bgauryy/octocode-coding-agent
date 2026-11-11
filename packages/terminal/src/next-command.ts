/** What a model is told when it suggests the rest of a shell command. */
export interface NextCommandRequest {
	/** What the user typed after `!`; empty when they have typed nothing yet. */
	prefix: string;
	cwd: string;
	shell: string;
	platform: NodeJS.Platform;
	/** The latest commands the user ran here, oldest first, with exit codes when known. */
	recent: Array<{ command: string; exitCode?: number | null }>;
	/** Shell commands from the agent's last reply. */
	reply: string[];
}

/** One model call: the model's raw reply, or undefined (no model, an error, aborted). */
export type AskModel = (request: NextCommandRequest, signal: AbortSignal) => Promise<string | undefined>;

/** The command in a model reply, or undefined when it does not extend `prefix`, says `NONE`, spans lines or is empty. */
export function commandFromReply(reply: string, prefix: string): string | undefined {
	let text = reply.trim();
	const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
	if (fenced) text = fenced[1].trim();
	text = text.replace(/^`+|`+$/g, "").trim();
	text = text.replace(/^(\$|!)\s*/, "");
	if (!text || text.includes("\n") || /[\x00-\x1f\x7f]/.test(text)) return undefined;
	if (text.toUpperCase() === "NONE") return undefined;
	if (prefix && (!text.startsWith(prefix) || text.length <= prefix.length)) return undefined;
	return text;
}

const MAX_CACHED_PREFIXES = 256;

interface RunningSuggestion {
	controller: AbortController;
	call: Promise<string | undefined>;
}

/** Cached model suggestions and shared calls per folder and prefix; context changes discard both. */
export class NextCommandSuggester {
	private readonly cache = new Map<string, string | null>();
	private readonly running = new Map<string, RunningSuggestion>();
	private readonly ask: AskModel;

	constructor(ask: AskModel) {
		this.ask = ask;
	}

	/** The cached answer for `prefix` in `cwd`: a command, null for a miss, undefined when not asked yet. */
	cached(cwd: string, prefix: string): string | null | undefined {
		const key = `${cwd}\0${prefix}`;
		const known = this.cache.get(key);
		if (known !== undefined) {
			this.cache.delete(key);
			this.cache.set(key, known);
		}
		return known;
	}

	async suggest(request: NextCommandRequest, signal: AbortSignal): Promise<string | undefined> {
		if (signal.aborted) return undefined;
		const key = `${request.cwd}\0${request.prefix}`;
		const known = this.cached(request.cwd, request.prefix);
		if (known !== undefined) return known ?? undefined;
		const entry = this.running.get(key) ?? this.start(request, key, signal);
		return new Promise((resolve) => {
			const finish = (command: string | undefined) => {
				signal.removeEventListener("abort", onAbort);
				resolve(signal.aborted ? undefined : command);
			};
			const onAbort = () => finish(undefined);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			else void entry.call.then(finish);
		});
	}

	private start(request: NextCommandRequest, key: string, signal: AbortSignal): RunningSuggestion {
		const controller = new AbortController();
		let resolve!: (command: string | undefined) => void;
		const entry = {
			controller,
			call: new Promise<string | undefined>((done) => {
				resolve = done;
			}),
		};
		this.running.set(key, entry);
		let settled = false;
		const onAbort = () => controller.abort();
		const onCanceled = () => finish(undefined, false);
		const finish = (command: string | undefined, cache = true) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			controller.signal.removeEventListener("abort", onCanceled);
			if (this.running.get(key) === entry) {
				this.running.delete(key);
				if (cache && !controller.signal.aborted) {
					this.cache.set(key, command ?? null);
					if (this.cache.size > MAX_CACHED_PREFIXES) this.cache.delete(this.cache.keys().next().value!);
				}
			}
			resolve(command);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		controller.signal.addEventListener("abort", onCanceled, { once: true });
		try {
			void this.ask(request, controller.signal).then(
				(reply) => finish(reply === undefined ? undefined : commandFromReply(reply, request.prefix)),
				() => finish(undefined, false),
			);
		} catch {
			finish(undefined, false);
		}
		return entry;
	}

	forget(): void {
		this.cache.clear();
		for (const entry of this.running.values()) entry.controller.abort();
		this.running.clear();
	}
}

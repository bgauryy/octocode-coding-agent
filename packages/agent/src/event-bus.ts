export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

/**
 * A channel-keyed event bus with no Node dependency, so the package stays browser-safe. Handlers run in subscription
 * order; a handler added or removed during an emit takes effect from the next emit.
 */
export function createEventBus(): EventBusController {
	const channels = new Map<string, Set<(data: unknown) => Promise<void>>>();
	return {
		emit: (channel, data) => {
			const handlers = channels.get(channel);
			// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot: changes during this emit apply from the next one
			if (handlers) for (const handler of [...handlers]) void handler(data);
		},
		// Handlers may be async; their results are awaited so rejections are reported.
		on: (channel, handler: (data: unknown) => unknown) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					process.stderr.write(`Event handler error (${channel}): ${String(err)}\n`);
				}
			};
			let handlers = channels.get(channel);
			if (!handlers) channels.set(channel, (handlers = new Set()));
			handlers.add(safeHandler);
			return () => {
				handlers.delete(safeHandler);
				if (handlers.size === 0 && channels.get(channel) === handlers) channels.delete(channel);
			};
		},
		clear: () => {
			channels.clear();
		},
	};
}

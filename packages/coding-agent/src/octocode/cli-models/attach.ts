import { type FeatureSetup, readsMessagesOnly } from "../../core/features/index.ts";
import type { RouteBackend } from "./backend.ts";

/**
 * Registers the provider and ties it to the session: each Octocode session reuses one agent session, closed when the
 * session ends or another starts, and only the agent loop's own requests are its turns.
 */
export function attachBackend(api: FeatureSetup, backend: RouteBackend): void {
	const id = backend.provider.id;
	api.providers.register(backend.provider);
	api.bus.on("session_start", async (_event, ctx) => backend.bind(ctx.sessionManager.getSessionId(), ctx.cwd));
	api.bus.on(
		"context",
		readsMessagesOnly(async (_event, ctx) => {
			if (ctx.model?.provider === id) backend.markTurn();
		}),
	);
	api.bus.on("session_shutdown", async () => backend.close());
}

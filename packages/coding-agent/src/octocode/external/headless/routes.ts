import { claudeRoute } from "./claude.ts";
import { codexRoute } from "./codex.ts";
import { cursorRoute } from "./cursor.ts";
import { geminiRoute } from "./gemini.ts";
import { opencodeRoute } from "./opencode.ts";
import type { HeadlessRoute } from "./types.ts";

/** One headless route per runner, used when its ACP adapter is not available. */
export const HEADLESS_ROUTES: readonly HeadlessRoute[] = [
	claudeRoute,
	codexRoute,
	geminiRoute,
	opencodeRoute,
	cursorRoute,
];

export const headlessRoute = (runner: string): HeadlessRoute | undefined =>
	HEADLESS_ROUTES.find((route) => route.id === runner);

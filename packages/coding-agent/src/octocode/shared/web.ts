import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { serialQueue } from "../../../../common/src/serial-queue.ts";
import { say } from "./commands.ts";
import { createAppWindow } from "./browser-app.ts";
import { openOnHost, planOpen } from "./host-opener.ts";

interface WebServer {
	url: string;
	close(): Promise<void>;
	validate?: () => Promise<boolean>;
}

/**
 * Opens the per-session web server's page. The default opener is an isolated app window (`web.window`), which closes
 * with the server: its page is useless once the server stops. An injected `open` replaces it. A notice from the
 * opener (the page fell back to the default browser) is shown to the session.
 */
export function webLauncher(api: ExtensionAPI, open?: (url: string) => Promise<string | void>) {
	const appWindow = createAppWindow({ mode: () => api.getSettings().web?.window ?? "app" });
	const opener = open ?? appWindow.open;
	let context: ExtensionContext | undefined;
	api.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	let server: WebServer | undefined;
	let key = "";
	const enqueue = serialQueue();
	const close = () =>
		enqueue(async () => {
			const previous = server;
			server = undefined;
			await previous?.close();
			await appWindow.close();
		});
	api.on("session_start", close);
	api.on("session_shutdown", close);
	return (sessionKey: string, start: () => Promise<WebServer>, view: "board" | "activity", item?: string) =>
		enqueue(async () => {
			if (server && !((await server.validate?.().catch(() => false)) ?? true)) {
				const previous = server;
				server = undefined;
				await previous.close();
			}
			if (!server || key !== sessionKey) {
				const previous = server;
				server = undefined;
				await previous?.close();
				server = await start();
				key = sessionKey;
			}
			const url = new URL(server.url);
			const fragment = new URLSearchParams(url.hash.slice(1));
			fragment.set("view", view);
			if (item) fragment.set("item", item);
			url.hash = fragment.toString();
			try {
				// An item opened by click or `/web item` may come from an SSH or headless session: give the address there.
				const notice = item ? await openOnHost(url.href, opener, planOpen()) : await opener(url.href);
				if (notice && context) say(context, notice, "warning");
			} catch (error) {
				// The server is running: give the address, so a headless or SSH session can still reach it.
				throw new Error(`no browser could be started (${errorMessage(error)}); open ${url.href}`, { cause: error });
			}
			return url.href;
		});
}

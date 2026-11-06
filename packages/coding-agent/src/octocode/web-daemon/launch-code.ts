import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { Reply } from "./http-util.ts";
import { ITEM_REF } from "../shared/item-ref.ts";

/**
 * What `/web` opens instead of the launch token. A URL given to `xdg-open` or a browser sits in a process argument, which
 * another local user can read on a shared Linux host (`/proc/<pid>/cmdline`, unless `hidepid` is set), and a browser may
 * keep it for its lifetime. The launch token would be the admin capability from then on. This code opens the page once:
 * the first request redirects to the page with the token in the fragment, which the browser never sends and the page
 * moves to session storage (`webview/src/access.ts`). A code nobody used (no browser came up) ends on its own, so one
 * left in an argument is not a lasting capability.
 */

/** The route that hands out a code (launch capability only, under `/api/admin/`). */
export const LAUNCH_CODE_ROUTE = "/api/admin/launch-code";
/** The page's one-time door: `/open/<code>?s=<session>&view=<view>&item=<B12>`; takes no bearer token. */
export const LAUNCH_DOOR_PREFIX = "/open/";
const CODE_LIFETIME_MS = 5 * 60_000;
const VIEW = /^[a-z]{1,32}$/;
const SESSION = /^[\w.-]{1,128}$/;

export class LaunchCodes {
	private readonly codes = new Map<string, number>();
	private readonly now: () => number;
	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	issue(): string {
		const code = randomBytes(32).toString("hex");
		for (const [old, expires] of this.codes) if (expires <= this.now()) this.codes.delete(old);
		this.codes.set(code, this.now() + CODE_LIFETIME_MS);
		return code;
	}

	/** Whether `code` is live; a live code works once. */
	take(code: string): boolean {
		const expires = this.codes.get(code);
		this.codes.delete(code);
		return expires !== undefined && expires > this.now();
	}
}

/**
 * Answers `GET /open/<code>`: a 303 to the page, with the launch token in its fragment, or a refusal that says how to get
 * a new link. The redirect is not cached and sends no referrer, as the page itself does not.
 */
export function openDoor(
	url: URL,
	codes: LaunchCodes,
	launchToken: string,
	res: http.ServerResponse,
	reply: Reply,
): void {
	if (!codes.take(url.pathname.slice(LAUNCH_DOOR_PREFIX.length)))
		return reply(401, { error: "This link was already used or has expired. Run /web again." });
	const session = url.searchParams.get("s");
	const view = url.searchParams.get("view");
	const item = url.searchParams.get("item");
	const query = session && SESSION.test(session) ? `?s=${session}` : "";
	const fragment = new URLSearchParams({
		access: launchToken,
		...(view && VIEW.test(view) ? { view } : {}),
		...(item && ITEM_REF.test(item) ? { item } : {}),
	});
	res.writeHead(303, {
		location: `/${query}#${fragment.toString()}`,
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	});
	res.end();
}

import type http from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getAgentDir } from "../../config.ts";
import { FileSettingsStorage } from "../../core/settings-manager/storage.ts";
import { readJsonBody } from "../shared/json-body.ts";

type Reply = (status: number, body: unknown) => void;
const MAX_BODY_BYTES = 1024;

/**
 * Routes both web page servers (the user-level daemon and a session's own) answer the same way: the service worker
 * that delivers notification clicks, and the workspace preferences the host keeps because a launch starts with a
 * fresh browser profile.
 */

/** The worker's route and source and the preferences route, from the webview package (`WEB_PAGE_ASSETS`). */
export interface WebPageAssets {
	workerRoute: string;
	workerSource: string;
	prefsRoute: string;
}

const WEB_THEMES = ["system", "light", "dark"] as const;
type WebTheme = (typeof WEB_THEMES)[number];

/** What the page may keep on the host: `web.sound` (off unless turned on) and `web.theme` (system unless chosen), in the global settings file. */
export interface WebPrefs {
	sound: boolean;
	theme: WebTheme;
}

export interface WebPrefsStore {
	read(): WebPrefs;
	/** Throws when the settings file cannot be read or written; it never replaces a file that does not parse. */
	write(patch: Partial<WebPrefs>): WebPrefs;
}

const WebPrefsSchema = Type.Object(
	{
		sound: Type.Optional(Type.Boolean()),
		theme: Type.Optional(Type.Union(WEB_THEMES.map((theme) => Type.Literal(theme)))),
	},
	{ additionalProperties: false, minProperties: 1 },
);

/** A settings-file problem whose message is safe to show the page: it names no path and quotes no content. */
class SettingsFileError extends Error {}

function parsed(text: string | undefined): Record<string, unknown> {
	if (text === undefined || text.trim() === "") return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		// The parser's message can quote file content: say only what to do.
		throw new SettingsFileError("The global settings file is not valid JSON; fix it in a terminal first.", {
			cause: error,
		});
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new SettingsFileError("The global settings file is not a JSON object; fix it in a terminal first.");
	return value as Record<string, unknown>;
}

function prefsOf(settings: Record<string, unknown>): WebPrefs {
	const web = settings.web;
	const { sound, theme } = typeof web === "object" && web !== null ? (web as Record<string, unknown>) : {};
	return { sound: sound === true, theme: WEB_THEMES.find((name) => name === theme) ?? "system" };
}

/** The preferences in the global settings file, read and written through the settings storage's own lock. */
export function settingsWebPrefs(agentDir: () => string = getAgentDir): WebPrefsStore {
	const storage = () => new FileSettingsStorage(agentDir(), agentDir());
	return {
		read() {
			let prefs: WebPrefs = { sound: false, theme: "system" };
			storage().withLock(
				"global",
				(current) => {
					prefs = prefsOf(parsed(current));
					return undefined;
				},
				{ readOnly: true },
			);
			return prefs;
		},
		write(patch) {
			let prefs: WebPrefs = { sound: false, theme: "system" };
			storage().withLock("global", (current) => {
				const settings = parsed(current);
				const web = typeof settings.web === "object" && settings.web !== null ? settings.web : {};
				prefs = { ...prefsOf(settings), ...patch };
				return `${JSON.stringify({ ...settings, web: { ...web, ...patch } }, null, 2)}\n`;
			});
			return prefs;
		},
	};
}

/**
 * `GET /octocode-sw.js`: static code, like the page itself, so it needs no token (the caller has already checked host and
 * origin). Never cached, so a new build's worker replaces the old one. Returns false for any other request.
 */
export function serveServiceWorker(
	req: http.IncomingMessage,
	pathname: string,
	res: http.ServerResponse,
	assets: WebPageAssets,
): boolean {
	if (req.method !== "GET" || pathname !== assets.workerRoute) return false;
	res.writeHead(200, {
		"content-type": "text/javascript; charset=utf-8",
		"cache-control": "no-store",
		"service-worker-allowed": "/",
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'",
	});
	res.end(assets.workerSource);
	return true;
}

/**
 * `GET` and `POST /api/web-prefs`, after the caller has authenticated the request (and, for a POST, checked that the
 * capability may change settings). Returns false for any other route.
 */
export async function handleWebPrefsRequest(
	req: http.IncomingMessage,
	pathname: string,
	store: WebPrefsStore,
	reply: Reply,
	assets: WebPageAssets,
): Promise<boolean> {
	if (pathname !== assets.prefsRoute) return false;
	if (req.method !== "GET" && req.method !== "POST") {
		reply(405, { error: "Method not allowed" });
		return true;
	}
	try {
		if (req.method === "GET") {
			reply(200, store.read());
			return true;
		}
		const body = await readJsonBody(req, reply, MAX_BODY_BYTES);
		if (body === undefined) return true;
		if (!Value.Check(WebPrefsSchema, body)) {
			reply(400, { error: "Invalid preferences" });
			return true;
		}
		reply(200, store.write(body));
	} catch (error) {
		// Only a message written for the page is passed on: other errors can carry the settings path under the home directory.
		reply(500, {
			error: `The preferences could not be saved.${error instanceof SettingsFileError ? ` ${error.message}` : ""}`,
		});
	}
	return true;
}

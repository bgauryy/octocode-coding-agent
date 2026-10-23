export type Params = Record<string, string>;
export interface Route {
	name: string;
	params: Params;
}
export type Destination =
	| { kind: "view"; view: string; params: Params }
	| { kind: "item"; ref: string; mode: "view" | "edit" | "correct" }
	| { kind: "new" };

const ITEM_ROUTE = /^([Bb][0-9]+)(?:\/(edit|correct))?$/;

function decode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** The hash holds the view, its filters and the open item: `#table?state=todo`, `#B12`, `#B12/edit`. */
export function parseHash(hash: string): Route {
	const raw = hash.replace(/^#/, "");
	const q = raw.indexOf("?");
	const params: Params = {};
	if (q >= 0) {
		for (const pair of raw.slice(q + 1).split("&")) {
			if (!pair) continue;
			const i = pair.indexOf("=");
			params[decode(i < 0 ? pair : pair.slice(0, i))] = i < 0 ? "" : decode(pair.slice(i + 1));
		}
	}
	return { name: q < 0 ? raw : raw.slice(0, q), params };
}

export function hashFor(name: string, params: Params = {}): string {
	const parts = Object.entries(params)
		.filter(([, value]) => value)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
	return `#${name}${parts.length ? `?${parts.join("&")}` : ""}`;
}

export function resolveRoute(route: Route, views: readonly string[]): Destination {
	const item = ITEM_ROUTE.exec(route.name);
	if (item) return { kind: "item", ref: item[1].toUpperCase(), mode: (item[2] as "edit" | "correct") ?? "view" };
	if (route.name === "new") return { kind: "new" };
	if (views.includes(route.name)) return { kind: "view", view: route.name, params: route.params };
	return { kind: "view", view: "board", params: {} };
}

/** `/backlog` launches with `#access=…&view=…`; the token moves to session storage and the hash becomes a plain view. */
export function readLaunch(hash: string): { access: string; hash: string } | null {
	if (!hash.startsWith("#access=")) return null;
	const launch = new URLSearchParams(hash.slice(1));
	return { access: launch.get("access") ?? "", hash: launch.get("view") === "activity" ? "#activity" : "#board" };
}

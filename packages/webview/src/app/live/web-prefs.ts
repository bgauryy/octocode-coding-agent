import { bearer } from "../../access.ts";
import { requestJson } from "../../request.ts";
import { WEB_PREFS_ROUTE } from "../../service-worker.ts";
import type { Theme, ThemePrefs } from "../extension.ts";

const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** Preferences the host keeps for the workspace: browser storage does not survive a launch, so the host holds them. */
export interface WebPrefs {
	sound: boolean;
	theme: Theme;
}

/** A host from before themes sends no `theme`: that reads as System. */
function prefsFrom(value: unknown): WebPrefs {
	if (typeof value !== "object" || value === null || typeof (value as WebPrefs).sound !== "boolean")
		throw new Error("Invalid preferences response");
	const { sound, theme } = value as { sound: boolean; theme?: unknown };
	return { sound, theme: THEMES.find((name) => name === theme) ?? "system" };
}

/** User-level, so never scoped to a session or repository. */
export async function readWebPrefs(access: string): Promise<WebPrefs> {
	return prefsFrom(await requestJson(WEB_PREFS_ROUTE, { headers: bearer(access) }, "Could not load preferences"));
}

/** Saves the given fields; the host keeps the others as they are. Needs the launch capability. */
export async function writeWebPrefs(access: string, prefs: Partial<WebPrefs>): Promise<WebPrefs> {
	return prefsFrom(
		await requestJson(
			WEB_PREFS_ROUTE,
			{
				method: "POST",
				headers: { ...bearer(access), "Content-Type": "application/json" },
				body: JSON.stringify(prefs),
			},
			"Could not save preferences",
		),
	);
}

export const themePrefs: ThemePrefs = {
	read: async (access) => (await readWebPrefs(access)).theme,
	save: async (access, theme) => {
		await writeWebPrefs(access, { theme });
	},
};

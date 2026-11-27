import { useCallback, useEffect, useRef, useState } from "react";
import type { Theme, ThemePrefs } from "./extension.ts";

/** Sets the theme on the document: `system` removes the override so `prefers-color-scheme` decides again. */
function applyTheme(theme: Theme): void {
	if (theme === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
}

/**
 * The page's theme: it applies the choice and tracks it. With `prefs` (a live page) and `canSave` it reads the
 * host-stored choice once and saves a change; a read result that arrives after the user chose is ignored. Without
 * them (an offline export, a read-only page) it starts on System and applies a choice for this visit only.
 */
export function useTheme(
	prefs: ThemePrefs | undefined,
	access: string | null,
	canSave: boolean,
): { theme: Theme; setTheme: (theme: Theme) => void; problem?: string } {
	const [theme, choose] = useState<Theme>("system");
	const [problem, setProblem] = useState<string | undefined>();
	const chosen = useRef(false);
	// The host is used only on a live page that may write; otherwise the choice stays in the page.
	const hostAccess = prefs && canSave ? access : null;
	useEffect(() => {
		if (!prefs || hostAccess === null) return;
		let current = true;
		prefs.read(hostAccess).then(
			(value) => current && !chosen.current && choose(value),
			(error: unknown) => current && setProblem(`Could not read the theme: ${String(error)}`),
		);
		return () => {
			current = false;
		};
	}, [prefs, hostAccess]);
	useEffect(() => {
		applyTheme(theme);
		return () => applyTheme("system");
	}, [theme]);
	const setTheme = useCallback(
		(next: Theme) => {
			chosen.current = true;
			choose(next);
			setProblem(undefined);
			if (!prefs || hostAccess === null) return;
			prefs.save(hostAccess, next).catch((error: unknown) => setProblem(`Could not save the theme: ${String(error)}`));
		},
		[prefs, hostAccess],
	);
	return { theme, setTheme, problem };
}

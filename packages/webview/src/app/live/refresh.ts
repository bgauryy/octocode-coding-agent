/** Reloads the board and reports whether that worked, so the caller can tell the person instead of silently showing old data. */
export async function tryRefresh(refresh: () => Promise<void>): Promise<boolean> {
	try {
		await refresh();
		return true;
	} catch {
		return false;
	}
}

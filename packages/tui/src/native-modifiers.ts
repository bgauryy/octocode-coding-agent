import { getNativePlatformHelper, type ModifierKey } from "./native-platform.ts";

export function isNativeModifierPressed(key: ModifierKey): boolean {
	const helper = getNativePlatformHelper();
	if (!helper?.isModifierPressed) return false;
	try {
		return helper.isModifierPressed(key);
	} catch {
		return false;
	}
}

/**
 * Make the first native modifier query now. The first query loads the native module and the system's event source
 * (about 30 ms on macOS); later ones take microseconds. Run it while the terminal starts, so the first Enter that
 * checks for Shift does not pay it.
 */
export function warmNativeModifiers(): void {
	isNativeModifierPressed("shift");
}

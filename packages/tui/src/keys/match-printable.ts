import { isDigitKey, matchesKittySequence, matchesPrintableModifyOtherKeys, rawCtrlChar } from "./sequences.ts";
import { _kittyProtocolActive } from "./state.ts";
import { MODIFIERS, SYMBOL_KEYS } from "./tables.ts";

/** Match a single letter, digit or symbol key with its modifiers. */
export function matchesPrintableKey(data: string, key: string, modifier: number): boolean {
	const codepoint = key.charCodeAt(0);
	const rawCtrl = rawCtrlChar(key);
	const isLetter = key >= "a" && key <= "z";
	const isDigit = isDigitKey(key);

	if (modifier === MODIFIERS.ctrl + MODIFIERS.alt && !_kittyProtocolActive && rawCtrl) {
		// Legacy: ctrl+alt+key is ESC followed by the control character.
		// If that legacy form does not match, continue so CSI-u and
		// modifyOtherKeys sequences from tmux can still be recognized.
		if (data === `\x1b${rawCtrl}`) return true;
	}

	if (modifier === MODIFIERS.alt && !_kittyProtocolActive && (isLetter || isDigit || SYMBOL_KEYS.has(key))) {
		// Legacy: alt+printable key is ESC followed by the key
		if (data === `\x1b${key}`) return true;
	}

	if (modifier === MODIFIERS.ctrl) {
		// Legacy: ctrl+key sends the control character
		if (rawCtrl && data === rawCtrl) return true;
		return (
			matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
			matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
		);
	}

	if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
		return (
			matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) ||
			matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl)
		);
	}

	if (modifier === MODIFIERS.shift) {
		// Legacy: shift+letter produces uppercase
		if (isLetter && data === key.toUpperCase()) return true;
		return (
			matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
			matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift)
		);
	}

	if (modifier !== 0) {
		return (
			matchesKittySequence(data, codepoint, modifier) || matchesPrintableModifyOtherKeys(data, codepoint, modifier)
		);
	}

	// Check both raw char and Kitty sequence (needed for release events)
	return (
		data === key || matchesKittySequence(data, codepoint, 0) || matchesPrintableModifyOtherKeys(data, codepoint, 0)
	);
}

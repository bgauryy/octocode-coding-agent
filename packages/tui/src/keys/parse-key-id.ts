import { MODIFIER_NAMES } from "./tables.ts";

export interface ParsedKeyId {
	readonly key: string;
	readonly ctrl: boolean;
	readonly shift: boolean;
	readonly alt: boolean;
	readonly super: boolean;
}

/** Parsed key ids: bindings and literal key names are a small set, checked on every key. */
const parsedKeyIds = new Map<string, ParsedKeyId | null>();
const MAX_PARSED_KEY_IDS = 1024;

export function parseKeyId(keyId: string): ParsedKeyId | null {
	let parsed = parsedKeyIds.get(keyId);
	if (parsed === undefined) {
		if (parsedKeyIds.size >= MAX_PARSED_KEY_IDS) parsedKeyIds.clear();
		parsed = parseKeyIdUncached(keyId);
		parsedKeyIds.set(keyId, parsed && Object.freeze(parsed));
	}
	return parsed;
}

function parseKeyIdUncached(keyId: string): ParsedKeyId | null {
	let key = keyId.toLowerCase();
	const modifiers = new Set<(typeof MODIFIER_NAMES)[number]>();
	while (true) {
		const modifier = MODIFIER_NAMES.find((name) => key.startsWith(`${name}+`));
		if (!modifier) break;
		if (modifiers.has(modifier)) return null;
		modifiers.add(modifier);
		key = key.slice(modifier.length + 1);
	}
	if (!key || (key.includes("+") && key !== "+")) return null;
	return {
		key,
		ctrl: modifiers.has("ctrl"),
		shift: modifiers.has("shift"),
		alt: modifiers.has("alt"),
		super: modifiers.has("super"),
	};
}

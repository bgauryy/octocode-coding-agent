/**
 * Filesystem bindings (workspace root, transcript file) were once stored as `dev:ino:birth` and are now `ino:birth`: the
 * device number is renumbered by macOS across reboots. Stored rows are never rewritten to match; every comparison
 * goes through this one owner, so a stored `dev:ino:birth` and a live `ino:birth` name the same file when ino and birth
 * agree, and an older reader keeps seeing the rows it wrote.
 */
const LEGACY = /^\d+:(\d+:\d+)$/;

/** `ino:birth` of a binding in either format; any other value is returned as is. */
export const bindingKey = (binding: string): string => LEGACY.exec(binding)?.[1] ?? binding;

/** True when both bindings name the same file in either format. */
export const sameBinding = (a: string, b: string): boolean => bindingKey(a) === bindingKey(b);

/** The SQL form of `bindingKey` for column or parameter expression `value` (a `dev:ino:birth` text loses its prefix). */
export const bindingKeySql = (value: string): string =>
	`(CASE WHEN ${value} GLOB '[0-9]*:[0-9]*:[0-9]*' THEN substr(${value}, instr(${value}, ':') + 1) ELSE ${value} END)`;

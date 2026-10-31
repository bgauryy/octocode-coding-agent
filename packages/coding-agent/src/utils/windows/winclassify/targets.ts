import os from "node:os";
import type { ScriptElement } from "./types.ts";

/** `text` without one pair of matching quotes around it. */
export const unquote = (text: string): string => text.replace(/^(['"])(.*)\1$/s, "$2");

/** The text an element stands for: its string value, else its source with one pair of quotes removed. */
export function elementText(element: ScriptElement): string {
	if (element.value !== undefined) return element.value;
	return unquote(element.text);
}

/** Splits `text` at the commas outside quotes and parentheses: how PowerShell writes an array argument (`.\build, C:\Users\me`). */
function splitList(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote = "";
	let depth = 0;
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (char === "`") {
			current += char + (text[at + 1] ?? "");
			at++;
			continue;
		}
		if (quote) quote = char === quote ? "" : quote;
		else if (char === '"' || char === "'") quote = char;
		else if (char === "(" || char === "{") depth++;
		else if (char === ")" || char === "}") depth = Math.max(0, depth - 1);
		else if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** The paths an argument stands for: one string constant, or the elements of an array written as source (`'a', 'b'`), each without its quotes. */
export const textTargets = (text: string): string[] => splitList(text).map(unquote);
export const elementTargets = (element: ScriptElement): string[] =>
	element.value !== undefined ? [element.value] : textTargets(element.text);

/** `-Name:$false` / `-Name:0` turns a switch off. */
export const switchOff = (element: ScriptElement): boolean =>
	element.arg !== undefined && /^\$?(?:false|0)$/i.test(element.arg.trim());

/** Environment references to the profile and system folders, in PowerShell's and cmd's spellings, with the Windows default they stand for. */
const VARIABLES: ReadonlyArray<readonly [RegExp, string]> = [
	[/^(?:~|\$\{?home\}?|\$env:userprofile|%userprofile%)(?=\\|$)/, "c:\\users\\~"],
	[/^(?:\$env:(?:systemroot|windir)|%(?:systemroot|windir)%)(?=\\|$)/, "c:\\windows"],
	[/^(?:\$env:programfiles\(x86\)|%programfiles\(x86\)%)(?=\\|$)/, "c:\\program files (x86)"],
	[/^(?:\$env:programfiles|%programfiles%)(?=\\|$)/, "c:\\program files"],
	[/^(?:\$env:programdata|%programdata%)(?=\\|$)/, "c:\\programdata"],
	[/^(?:\$env:systemdrive|%systemdrive%)(?=\\|$)/, "c:"],
];

/** `path` without `.` and `..` segments (`D:\work\..\..` is `D:`; above a root stays at the root; a relative path keeps leading `..`) and without a trailing separator; a path with a variable left in it is not touched. */
function resolveDots(path: string): string {
	if (path === "" || /[$%(@]/.test(path)) return path.length > 1 ? path.replace(/\\+$/, "") : path;
	const drive = /^[a-z]:(?=\\|$)/.exec(path)?.[0];
	const rooted = drive !== undefined || path.startsWith("\\");
	const stack: string[] = [];
	for (const part of (drive ? path.slice(2) : path).split("\\")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") stack.push(part);
		else if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
		else if (!rooted) stack.push("..");
	}
	const body = stack.join("\\");
	if (drive) return body ? `${drive}\\${body}` : drive;
	if (rooted) return body ? `\\${body}` : "\\";
	return body || ".";
}

/** `target` in a comparable form: lower case, `\` separators, no quotes, known variables expanded, no trailing separator or wildcard tail. */
export function normalizedTarget(target: string): { path: string; wildcard: boolean } {
	// `\\?\C:\x` and `\\.\C:\x` are `C:\x` (the prefix would otherwise read as a `?` wildcard).
	let path = unquote(target.trim())
		.toLowerCase()
		.replace(/\//g, "\\")
		.replace(/^\\\\[?.]\\(?=[a-z]:)/, "")
		.replace(/\\{2,}(?!$)/g, "\\");
	for (const [pattern, value] of VARIABLES) path = path.replace(pattern, value);
	const wildcard = /[*?[]/.test(path);
	// `C:\x\*` and `C:\x\*.*` stand for the folder's content: judged as the folder.
	path = path.replace(/\\\*(?:\.\*)?$/, "");
	return { path: resolveDots(path), wildcard };
}

/** Whether removing `path` (normalized) takes a drive, the users folder, a profile, a system folder or the current or parent folder with it. */
export function protectedTarget(path: string): boolean {
	const home = os.homedir().replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
	return (
		// A drive root, and any folder directly under one (`C:\x`): next to the root, not a project folder.
		/^(?:[a-z]:|\\)$/.test(path) ||
		/^[a-z]:\\[^\\]+$/.test(path) ||
		// A profile folder, whatever the user.
		/^[a-z]:\\users\\[^\\]+$/.test(path) ||
		(/^[a-z]:\\/.test(home) && (path === home || home.startsWith(`${path}\\`))) ||
		// System folders, and anything inside them.
		/^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|$)/.test(path) ||
		// The current folder and its parents.
		/^\.{1,2}(?:\\\.{1,2})*$/.test(path)
	);
}

/** Whether `path` is computed at run time (`$dir`, `(Get-Location)`), so its value cannot be judged. */
export const computed = (path: string): boolean => /^[$(@%]/.test(path);

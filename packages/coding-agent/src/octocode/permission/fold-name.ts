/**
 * The one comparison of protected names: the file gate (`file-access.ts`), the names later sessions load
 * (`later-session-loaded.ts`) and the curated memory files (`memory-files.ts`) all match a path folded this way. A leaf,
 * so each of them imports it without a cycle.
 */

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
/** A Windows name's trailing dots and spaces, which Win32 drops (`.mcp.json.` opens `.mcp.json`); `.` and `..` keep theirs. */
const WIN32_TRAILING = /(?<=[^\\/. ])[. ]+(?=[\\/]|$)/g;

/**
 * `name` (or a path) as a case-insensitive file system compares it, so a protected name matches every spelling that opens
 * the same file: NFKC (APFS ignores the composed/decomposed difference, and `ſ` becomes `s`), full case folding by
 * lower-, upper- and lower-casing (`ß` and `ẞ` become `ss`, the Kelvin sign `k`), without default-ignorable characters
 * (HFS+ skips them), and on Windows without a name's trailing dots and spaces. APFS, NTFS and the macOS sandbox fold
 * `ſ`, `ß` and `K` this way. It folds more than any one file system: an extra match only asks or refuses.
 */
export function foldName(name: string, platform: NodeJS.Platform = process.platform): string {
	const folded = name
		.normalize("NFKC")
		.toLowerCase()
		.toUpperCase()
		.toLowerCase()
		.normalize("NFKC")
		.replace(IGNORABLE, "");
	return platform === "win32" ? folded.replace(WIN32_TRAILING, "") : folded;
}

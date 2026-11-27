/**
 * Whether `FORCE_COLOR` asks for color (the convention behind https://force-color.org): set, and not empty, `0` or
 * `false`. It wins over `NO_COLOR`, as no-color.org recommends for an explicit user choice; `--color` sets it. A leaf with no imports, so the CLI's `--help` path can read it without loading the terminal interface.
 */
export function isColorForced(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	const value = env.FORCE_COLOR?.trim().toLowerCase();
	return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

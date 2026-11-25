/**
 * Whether the terminal's locale cannot show the design marks. The locale is the first non-empty of LC_ALL, LC_CTYPE
 * and LANG; it is ASCII-only when it names no UTF-8 charset (`C`, `POSIX`, `en_US.ISO-8859-1`). With no locale set,
 * macOS and Windows terminals still draw UTF-8, so only other platforms fall back.
 */
export function isAsciiLocale(env: Readonly<Record<string, string | undefined>>, platform: string): boolean {
	const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value !== undefined && value !== "");
	if (locale === undefined) return platform !== "darwin" && platform !== "win32";
	return !/utf-?8/i.test(locale);
}

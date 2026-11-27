/**
 * Whether the terminal's locale cannot show the design marks. The locale is the first non-empty of LC_ALL, LC_CTYPE
 * and LANG; it is ASCII-only when it names no UTF-8 charset (`C`, `POSIX`, `en_US.ISO-8859-1`). With no locale set the
 * glyphs stay: containers and SSH sessions often set none while their terminal draws UTF-8.
 */
export function isAsciiLocale(env: Readonly<Record<string, string | undefined>>, _platform: string): boolean {
	const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value !== undefined && value !== "");
	if (locale === undefined) return false;
	return !/utf-?8/i.test(locale);
}

/**
 * Key text as every hint, chip and shortcut table shows it: lowercase (`shift+tab`, `ctrl+c`), `esc` for `escape`, and
 * `option` for `alt` on macOS, the name printed on that key there. Keybinding files keep writing `alt`. `key` may hold
 * several keys joined by `/`.
 */
export function formatKeyText(key: string, platform: NodeJS.Platform = process.platform): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => {
					const lower = part.toLowerCase();
					if (lower === "escape") return "esc";
					return platform === "darwin" && lower === "alt" ? "option" : lower;
				})
				.join("+"),
		)
		.join("/");
}

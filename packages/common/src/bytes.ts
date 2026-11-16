/**
 * How a byte count reads:
 * - `compact` (truncation notices): `512B`, `1.0KB`, `1.0MB`.
 * - `spaced` (bash headers and job reports): `312 B`, `18 KB`, `2.1 MB`.
 * - `binary` (model downloads, which reach gigabytes): `312 B`, `1.50 KiB`, `12.3 MiB`, `4.20 GiB`.
 */
export type ByteStyle = "compact" | "spaced" | "binary";

const BINARY_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

/** The one byte-size formatter; `style` picks the wording a surface already shows. */
export function formatBytes(bytes: number, style: ByteStyle = "compact"): string {
	if (style === "binary") {
		if (bytes < 1024) return `${bytes} B`;
		let value = bytes / 1024;
		let unit: string = BINARY_UNITS[0];
		for (let index = 1; index < BINARY_UNITS.length && value >= 1024; index++) {
			value /= 1024;
			unit = BINARY_UNITS[index]!;
		}
		return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
	}
	const gap = style === "spaced" ? " " : "";
	if (bytes < 1024) return `${bytes}${gap}B`;
	if (bytes < 1024 * 1024) {
		const kilobytes = bytes / 1024;
		return `${style === "spaced" ? Math.round(kilobytes) : kilobytes.toFixed(1)}${gap}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}${gap}MB`;
}

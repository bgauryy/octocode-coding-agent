import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Every `.ts` file under `dir`, recursively. */
export function fdSync(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return fdSync(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Long-term memory: a JSON file that survives agent runs. */
export class MemoryStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private load(): Record<string, string> {
		return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>) : {};
	}

	read(key: string): string | undefined {
		return this.load()[key];
	}

	write(key: string, value: string): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify({ ...this.load(), [key]: value }, null, 2));
	}
}

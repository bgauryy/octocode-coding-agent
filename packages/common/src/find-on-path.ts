import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The first executable file named `command` on PATH, trying PATHEXT suffixes on Windows. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const suffixes =
		process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
	for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const suffix of suffixes) {
			const candidate = join(dir, `${command}${suffix}`);
			try {
				if (!statSync(candidate).isFile()) continue;
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Missing or not executable: try the next candidate.
			}
		}
	}
	return undefined;
}

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

const isWindows = process.platform === "win32";

function executableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		// Missing or not executable.
		return false;
	}
}

/**
 * The first executable file named `command` on PATH, trying PATHEXT suffixes on Windows (default `.EXE;.CMD;.BAT;.COM`).
 * A `command` that holds a path separator is checked as that path, not searched for.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (command.includes("/") || (isWindows && command.includes("\\"))) {
		return executableFile(command) ? command : undefined;
	}
	const suffixes = isWindows ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
	for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const suffix of suffixes) {
			const candidate = join(dir, `${command}${suffix}`);
			if (executableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

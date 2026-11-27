import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";

/** A tracked POSIX shell cannot start work until its owner records its process group. If the owner dies first, the pipe closes. */
export function spawnRegistered(
	file: string,
	args: readonly string[],
	options: Omit<SpawnOptions, "stdio"> & { stdio: Array<"pipe" | "ignore"> },
	register: (pid: number) => void,
): ChildProcess {
	const gate = 'IFS= read -r ready <&3 && [ "$ready" = go ] || exit 125; exec 3<&-; exec "$@"';
	const child = spawn("/bin/sh", ["-c", gate, "octocode-shell", file, ...args], {
		...options,
		stdio: [...options.stdio, "pipe"],
	});
	if (child.pid === undefined) return child;
	const pipe = child.stdio[3] as Writable;
	// The owner can cancel the group while its registration completes.
	pipe.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE" && error.code !== "ECONNRESET") child.emit("error", error);
	});
	try {
		register(child.pid);
		pipe.end("go\n");
	} catch (error) {
		pipe.destroy();
		throw error;
	}
	return child;
}

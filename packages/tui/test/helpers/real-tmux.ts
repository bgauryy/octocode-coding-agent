import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Stops the private tmux server on `-L <socket>` and removes its socket file. tmux leaves the file behind when the
 * server is killed, so without this every run adds a stale entry to `/tmp/tmux-<uid>/`.
 */
export function killPrivateTmuxServer(socket: string): void {
	spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
	rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
}

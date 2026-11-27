import { commandNames } from "../shell.ts";

/**
 * Programs that talk to the network: their output is untrusted, and a command line naming them leaves the machine.
 *
 * The list is deliberately only programs whose job is to fetch or send. Not covered, a known limit of the tripwire: `gh`,
 * `git clone|fetch|pull`, package managers, `docker pull` and interpreters that fetch (`python -c`, `node -e`), whose
 * subcommands are not told apart from local ones here, and a file such a command saves in the workspace, which later reads
 * trust as a workspace read.
 */
export const NETWORK = new Set([
	"curl",
	"wget",
	"nc",
	"ncat",
	"netcat",
	"socat",
	"telnet",
	"ftp",
	"sftp",
	"scp",
	"ssh",
	"rsync",
	"http",
	"https",
	"xh",
	"aria2c",
	"lynx",
	"w3m",
	"invoke-webrequest",
	"iwr",
	"invoke-restmethod",
	"irm",
]);

export const isNetworkCommand = (command: string): boolean =>
	commandNames(command).some((name) => NETWORK.has(name.toLowerCase()));

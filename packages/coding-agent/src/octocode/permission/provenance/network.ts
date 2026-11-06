import { commandNames } from "../shell.ts";

/** Programs that talk to the network: their output is untrusted, and a command line naming them leaves the machine. */
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

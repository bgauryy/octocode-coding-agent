import os from "node:os";
import path from "node:path";
import { base, mask, REMOVERS, SEPARATOR, SHELLS, shellScript, stdinOf, unhide, words } from "./words.ts";

const SYSTEM = /^(?:mkfs(?:\.[a-z0-9]+)?|newfs(?:_[a-z0-9]+)?|shutdown|reboot|halt|poweroff)$/i;
/** `diskutil` verbs that erase a disk or volume. */
const DISKUTIL_ERASE = /^(?:erase\w*|zeroDisk|randomDisk|secureErase)$/i;
/** dd writing to a device; the pseudo devices used to discard or print output are fine. */
const DD_DEVICE = /^of=\/dev\/(?!(?:null|zero|stdout|stderr|tty)$|fd\/)/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/;

/** Where a command runs: the home folder, and the shell's folder when known (`cd` moves it). */
interface Place {
	home: string;
	cwd: string | undefined;
}

/** `path` with the platform separator written as `/`. */
const posix = (file: string): string => file.split(path.sep).join("/");

/** `target` with a leading `~`, `$HOME` or `${HOME}` replaced by `home`. */
export const expandHome = (target: string, home: string): string =>
	target.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);

/**
 * Where a target lands with `~`, `$HOME` and `${HOME}` expanded and `.`/`..` resolved against the shell's folder; a
 * trailing `/*` glob counts as its folder. Undefined when it cannot be placed: relative with no folder known, or built
 * from another variable.
 */
function locate(target: string, { home, cwd }: Place): string | undefined {
	const expanded = expandHome(unhide(target), home);
	if (/\$/.test(expanded)) return undefined;
	const absolute = expanded.startsWith("/")
		? expanded
		: cwd?.startsWith("/")
			? path.posix.resolve(cwd, expanded)
			: undefined;
	if (absolute === undefined) return undefined;
	const normalized = path.posix.normalize(absolute).replace(/\/\.?\*$/, "") || "/";
	return normalized.length > 1 ? normalized.replace(/\/+$/, "") || "/" : normalized;
}

/** Folders whose files a command should not remove or re-permission: the system's own, and the SSH keys. */
const SYSTEM_DIRS = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/System"];

const isUnder = (where: string, dir: string): boolean => where === dir || where.startsWith(`${dir}/`);

/** The system folder (or `~/.ssh`) `where` is in, else undefined. */
const systemDir = (where: string, home: string): string | undefined =>
	[...SYSTEM_DIRS, `${home}/.ssh`].find((dir) => isUnder(where, dir));

/** Whether acting on `where` recursively would reach `/`, the home folder or a folder holding it. */
const holdsHome = (where: string, home: string): boolean =>
	where === "/" || home === where || home.startsWith(`${where}/`);

/** The protected place `target` names (`/`, home or above it, a system folder, `~/.ssh`), else undefined. */
function protectedPlace(target: string, place: Place): string | undefined {
	const where = locate(target, place);
	if (where === undefined) return undefined;
	return holdsHome(where, place.home) ? where : systemDir(where, place.home) !== undefined ? where : undefined;
}

const operandsOf = (tokens: string[]): string[] => tokens.slice(1).filter((token) => !token.startsWith("-"));

/** Why this `rm`-like command is destructive: recursive removal of `/`, home or a folder holding it, or any removal in a system folder. */
function removesProtected(tokens: string[], place: Place): string | undefined {
	const name = base(tokens[0] ?? "");
	if (!REMOVERS.has(name)) return undefined;
	const flags = tokens.slice(1).filter((token) => token.startsWith("-"));
	const targets = operandsOf(tokens);
	if (name === "rm" && flags.includes("--no-preserve-root"))
		return `recursive removal of ${targets.map(unhide).join(" ") || "/"}`;
	const recursive = name === "rm" && flags.some((flag) => flag === "--recursive" || /^-[a-z]*r/i.test(flag));
	for (const target of targets) {
		const where = locate(target, place);
		if (where === undefined) continue;
		if (recursive && holdsHome(where, place.home))
			return `recursive removal of ${unhide(target)}${where === unhide(target) ? "" : ` (${where})`}`;
		const system = systemDir(where, place.home);
		if (system) return `removal under ${system}`;
	}
	return undefined;
}

/** `chmod -R`, `chown -R` or `chgrp -R` on `/`, home or a folder holding it, a system folder or `~/.ssh`. */
function changesTree(tokens: string[], place: Place): string | undefined {
	const name = base(tokens[0] ?? "");
	if (name !== "chmod" && name !== "chown" && name !== "chgrp") return undefined;
	if (!tokens.slice(1).some((token) => token === "--recursive" || /^-[a-zA-Z]*R/.test(token))) return undefined;
	const target = operandsOf(tokens).find((operand) => protectedPlace(operand, place) !== undefined);
	return target === undefined ? undefined : `\`${name} -R\` on ${unhide(target)}`;
}

/** `find <protected folder> … -delete` (or `-exec rm`): removes everything under `/`, home or a system folder. */
function findDeletesRoot(tokens: string[], place: Place): boolean {
	if (base(tokens[0] ?? "") !== "find") return false;
	const rest = tokens.slice(1);
	while (/^-[HLP]$/.test(rest[0] ?? "")) rest.shift();
	const end = rest.findIndex((token) => /^[-(!]/.test(token));
	const roots = end < 0 ? rest : rest.slice(0, end);
	const deletes = rest.some(
		(token, at) => token === "-delete" || (/^-exec(?:dir)?$/.test(token) && base(rest[at + 1] ?? "") === "rm"),
	);
	return deletes && roots.some((root) => protectedPlace(root, place) !== undefined);
}

/** Block devices a stray write destroys (`/dev/sda`, `/dev/nvme0n1`, `/dev/disk2`, `/dev/rdisk2`, …). */
const BLOCK_DEVICE = /^\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|r?disk\d)/i;

/** The block device a simple command writes to (a redirect, `tee`, `shred`, `truncate`, `wipefs`, `blkdiscard`, or the last operand of `cp`/`mv`), else undefined. */
function writesDevice(tokens: string[]): string | undefined {
	const name = base(tokens[0] ?? "");
	const words = tokens.map(unhide);
	for (const [at, word] of words.entries()) {
		const redirect = /^(?:\d*|&)>>?\|?(.*)$/.exec(word);
		if (!redirect) continue;
		const target = redirect[1] || words[at + 1] || "";
		if (BLOCK_DEVICE.test(target)) return target;
	}
	const targets = operandsOf(words);
	const written = new Set(["tee", "shred", "truncate", "wipefs", "blkdiscard"]).has(name)
		? targets
		: ["cp", "mv"].includes(name)
			? targets.slice(-1)
			: [];
	return written.find((target) => BLOCK_DEVICE.test(target));
}

function emitted(tokens: string[], bodies: string[]): string[] {
	const name = base(tokens[0] ?? "");
	if (name === "echo" || name === "printf")
		return [
			tokens
				.slice(1)
				.filter((token) => !/^-[a-z]+$/i.test(token))
				.join(" "),
		];
	return name === "cat" ? stdinOf(tokens, bodies) : [];
}

/**
 * The shell's folder after `cd <target>` (or `pushd`), `home` for a bare `cd`; undefined when it cannot be told (`cd -`,
 * `cd $DIR`).
 */
function afterCd(tokens: string[], place: Place): string | undefined {
	const target = tokens.slice(1).find((token) => !/^-[LPe@]+$/.test(token));
	return target === undefined ? place.home : target === "-" ? undefined : locate(target, place);
}

/**
 * Why a shell command would be destructive (wipe `/` or home, `rm` in a system folder or `~/.ssh`, `chmod -R` on a
 * protected root, write to a disk device, format a disk, power off, fork-bomb), else undefined. Relative targets resolve
 * against `cwd`, which `cd` moves along the command line. It flags common destructive commands by reading the command's
 * words; it is not a security boundary (quoting and variable tricks get past it).
 */
export function catastrophicCommand(command: string, cwd?: string): string | undefined {
	return destructiveIn(command, { home: posix(os.homedir()), cwd: cwd === undefined ? undefined : posix(cwd) });
}

function destructiveIn(command: string, start: Place): string | undefined {
	const bodies: string[] = [];
	const masked = mask(command, bodies);
	if (FORK_BOMB.test(masked)) return "a fork bomb";
	const parts = masked.split(SEPARATOR);
	let place = start;
	let piped: string[] = [];
	for (let at = 0; at < parts.length; at += 2) {
		const tokens = words(parts[at]);
		const fromPipe = parts[at - 1] === "|" ? piped : [];
		piped = emitted(tokens, bodies).map(unhide);
		const name = base(tokens[0] ?? "");
		const removed = removesProtected(tokens, place);
		if (removed) return removed;
		if (findDeletesRoot(tokens, place)) return `\`find\` deleting everything under ${unhide(tokens[1] ?? "/")}`;
		const changed = changesTree(tokens, place);
		if (changed) return changed;
		if (SYSTEM.test(name)) return `\`${name}\``;
		if (name === "diskutil" && DISKUTIL_ERASE.test(tokens[1] ?? "")) return `\`diskutil ${tokens[1]}\``;
		if (name === "dd" && tokens.slice(1).some((token) => DD_DEVICE.test(unhide(token))))
			return "dd writing to a device";
		const device = writesDevice(tokens);
		if (device) return `a write to ${device}`;
		if (name === "cd" || name === "pushd") place = { ...place, cwd: afterCd(tokens, place) };
		const scripts: string[] = [];
		if (name === "eval") scripts.push(tokens.slice(1).map(unhide).join(" "));
		if (SHELLS.has(name)) {
			const shell = shellScript(tokens);
			if (shell.script !== undefined) scripts.push(unhide(shell.script));
			if (shell.stdin) scripts.push(...stdinOf(tokens, bodies).map(unhide), ...fromPipe);
		}
		for (const script of scripts) {
			const danger = destructiveIn(script, place);
			if (danger) return danger;
		}
	}
	return undefined;
}

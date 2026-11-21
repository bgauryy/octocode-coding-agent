#!/usr/bin/env node
/**
 * Fails on a relative Markdown link, in the shipped docs or a package README, whose `.md` target does not exist or
 * whose `#anchor` matches no heading of the target (GitHub slug rules, including the `-1` suffix of a repeated
 * heading). Links in fenced code, inline code and absolute URLs are not checked.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Text outside fenced code blocks, with the fences' lines blanked so line numbers stay valid. */
function proseLines(text) {
	let fence;
	return text.split("\n").map((line) => {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			return "";
		}
		if (marker) {
			fence = marker;
			return "";
		}
		return line;
	});
}

/** The anchor GitHub gives a heading: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
	return heading
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/[`*~]/g, "")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
		.replaceAll(" ", "-");
}

/** Every anchor of a Markdown file; a repeated heading gets `-1`, `-2`, ... */
export function anchors(text) {
	const seen = new Map();
	const result = new Set();
	for (const line of proseLines(text)) {
		const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
		if (heading === undefined) continue;
		const base = slug(heading);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		result.add(count ? `${base}-${count}` : base);
	}
	return result;
}

/** `[text](target)` links of a file as `{ line, target }`, skipping inline code. */
export function links(text) {
	return proseLines(text).flatMap((line, index) =>
		[...line.replace(/`[^`]*`/g, "").matchAll(/\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)].map((match) => ({
			line: index + 1,
			target: match[1],
		})),
	);
}

/** One message per broken link of `file`; `read(path)` returns a Markdown file's text, or undefined when it is missing. */
export function brokenLinks(file, text, read) {
	const problems = [];
	for (const { line, target } of links(text)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		const [path, anchor] = target.split("#");
		if (path !== "" && !path.endsWith(".md")) continue;
		const targetFile = path === "" ? file : resolve(dirname(file), path);
		const targetText = path === "" ? text : read(targetFile);
		if (targetText === undefined) problems.push(`${file}:${line} -> ${target}: no such file`);
		else if (anchor && !anchors(targetText).has(decodeURIComponent(anchor).toLowerCase()))
			problems.push(`${file}:${line} -> ${target}: no such heading`);
	}
	return problems;
}

function markdownFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : markdownFiles(full);
		return entry.name.endsWith(".md") ? [full] : [];
	});
}

function checkedFiles() {
	const packages = resolve(root, "packages");
	const readmes = readdirSync(packages)
		.map((name) => resolve(packages, name, "README.md"))
		.filter((path) => existsSync(path));
	return [
		...markdownFiles(resolve(root, "docs")),
		...markdownFiles(resolve(root, "packages/coding-agent/docs")),
		...readmes,
	];
}

function main() {
	const cache = new Map();
	const read = (path) => {
		if (!cache.has(path)) cache.set(path, existsSync(path) ? readFileSync(path, "utf8") : undefined);
		return cache.get(path);
	};
	const problems = checkedFiles().flatMap((file) => brokenLinks(file, read(file), read));
	if (problems.length) {
		console.error(
			`Broken Markdown links:\n${problems.map((problem) => `  ${problem.replaceAll(root, "")}`).join("\n")}`,
		);
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

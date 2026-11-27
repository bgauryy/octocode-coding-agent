import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The `max-lines` limit in `.oxlintrc.json`, where it fails the check; this module only warns ahead of it. */
const MAX_LINES = 400;
/** A split planned at this size is a design choice; one forced by the next edit is arithmetic mixed into a behavior change. */
const NEAR_LIMIT_LINES = 350;

const SOURCE = /\.(?:ts|tsx|mjs)$/;
/** What `.oxlintrc.json` exempts from `max-lines`: tests, generated data and vendored code. */
const EXEMPT = [
	/\.test\.[^/]+$/,
	/\.generated\.ts$/,
	/\.d\.ts$/,
	/(?:^|\/)(?:dist|node_modules|coverage|fixtures|test)\//,
	/^packages\/ai\/src\/providers\/data\//,
	/^packages\/coding-agent\/src\/core\/export-html\/vendor\//,
];

function sourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules" || entry.name === "dist") return [];
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return SOURCE.test(entry.name) ? [path] : [];
	});
}

/** Source files at or past `NEAR_LIMIT_LINES`, longest first, as `{ file, lines }` with paths relative to `root`. */
export function nearLimitFiles(root) {
	const roots = [
		...readdirSync(join(root, "packages"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, "packages", entry.name)),
		join(root, "scripts"),
	];
	return roots
		.flatMap(sourceFiles)
		.map((path) => ({ file: relative(root, path).split(sep).join("/"), path }))
		.filter(({ file }) => !EXEMPT.some((pattern) => pattern.test(file)))
		.map(({ file, path }) => ({ file, lines: readFileSync(path, "utf8").split("\n").length - 1 }))
		.filter(({ lines }) => lines >= NEAR_LIMIT_LINES)
		.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}

/** The one-paragraph notice for `yarn run check`, or undefined when no file is close. It never fails the check. */
export function nearLimitNotice(root, closest = 5) {
	const files = nearLimitFiles(root);
	if (files.length === 0) return undefined;
	const named = files
		.slice(0, closest)
		.map(({ file, lines }) => `${file} (${lines})`)
		.join(", ");
	return `note  ${files.length} source files are within ${MAX_LINES - NEAR_LIMIT_LINES} lines of the ${MAX_LINES}-line limit; plan a split before editing one. Closest: ${named}.`;
}

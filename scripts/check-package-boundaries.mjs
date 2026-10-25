import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceWorkspaceGroups } from "./source-workspaces.mjs";
import { moduleSpecifiers } from "./module-specifiers.mjs";

export const PACKAGE_POLICY = {
	acp: ["ai"],
	agent: ["ai"],
	mcp: ["agent", "ai", "tui"],
	ai: ["contacts", "telemetry"],
	"coding-agent": ["agent", "ai", "contacts", "tui", "webview"],
	contacts: [],
	telemetry: [],
	tui: [],
	webview: ["contacts"],
};

export function checkPackageBoundaries(packages, sources, policy = PACKAGE_POLICY) {
	const { hosts, issues } = sourceWorkspaceGroups(packages);
	const unit = (name) => hosts.get(name) ?? name;
	const names = new Map(Object.entries(packages).map(([dir, manifest]) => [manifest.name, dir]));
	const edges = new Map(Object.keys(packages).map((dir) => [dir, new Set()]));
	for (const [dir, manifest] of Object.entries(packages)) {
		if (!Object.hasOwn(policy, dir)) issues.push(`unclassified package: ${dir}`);
		for (const name of Object.keys({
			...manifest.dependencies,
			...manifest.peerDependencies,
			...manifest.optionalDependencies,
		})) {
			const target = names.get(name);
			if (!target) continue;
			if (unit(dir) !== unit(target)) edges.get(unit(dir)).add(unit(target));
			if (unit(dir) !== unit(target) && !(policy[dir] ?? []).includes(target))
				issues.push(`forbidden dependency: ${dir} -> ${target}`);
		}
	}
	for (const source of sources) {
		const manifest = packages[source.package];
		for (const specifier of source.imports) {
			let target = names.get(
				specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0],
			);
			if (specifier.startsWith(".")) {
				const resolved = path.posix
					.normalize(path.posix.join(source.package, path.posix.dirname(source.path), specifier))
					.split("/")[0];
				if (packages[resolved] && resolved !== source.package) {
					target = resolved;
					if (unit(source.package) !== unit(target))
						issues.push(`relative package import: ${source.package}/${source.path} -> ${specifier}`);
				}
			}
			if (!target || unit(target) === unit(source.package)) continue;
			edges.get(unit(source.package)).add(unit(target));
			if (!(policy[source.package] ?? []).includes(target))
				issues.push(`forbidden import: ${source.package}/${source.path} -> ${target}`);
			if (
				!Object.hasOwn(
					{ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies },
					packages[target].name,
				)
			)
				issues.push(`undeclared import: ${source.package}/${source.path} -> ${target}`);
		}
	}
	const done = new Set();
	function visit(dir, trail) {
		if (trail.includes(dir)) {
			issues.push(`package cycle: ${[...trail, dir].join(" -> ")}`);
			return;
		}
		if (done.has(dir)) return;
		for (const next of edges.get(dir) ?? []) visit(next, [...trail, dir]);
		done.add(dir);
	}
	for (const dir of Object.keys(packages)) visit(dir, []);
	return [...new Set(issues)];
}

export function scanPackageBoundaries(root) {
	const packages = {},
		sources = [];
	for (const dir of fs.readdirSync(path.join(root, "packages"))) {
		const folder = path.join(root, "packages", dir),
			manifest = path.join(folder, "package.json");
		if (!fs.existsSync(manifest)) continue;
		packages[dir] = JSON.parse(fs.readFileSync(manifest, "utf8"));
		const walk = (folder) =>
			fs
				.readdirSync(folder, { withFileTypes: true })
				.flatMap((entry) =>
					entry.isDirectory()
						? walk(path.join(folder, entry.name))
						: /\.[cm]?[jt]sx?$/.test(entry.name)
							? [path.join(folder, entry.name)]
							: [],
				);
		for (const file of walk(path.join(folder, "src"))) {
			if (file.endsWith(".generated.ts")) continue;
			const text = fs.readFileSync(file, "utf8");
			const imports = moduleSpecifiers(text, file).map((specifier) => specifier.value);
			sources.push({ package: dir, path: path.relative(folder, file).split(path.sep).join("/"), imports });
		}
	}
	return checkPackageBoundaries(packages, sources);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const issues = scanPackageBoundaries(process.cwd());
	if (issues.length) {
		console.error(issues.join("\n"));
		process.exitCode = 1;
	}
}

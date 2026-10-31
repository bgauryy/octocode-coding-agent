import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceWorkspaceGroups } from "./source-workspaces.mjs";
import { HOST_IMPORT_BASELINE } from "./host-import-baseline.mjs";
import { LAYER_RULES } from "./layer-import-baseline.mjs";
import { moduleSpecifiers } from "./module-specifiers.mjs";

export const PACKAGE_POLICY = {
	acp: ["ai", "common", "contracts", "mcp"],
	agent: ["ai"],
	common: ["contracts"],
	mcp: ["agent", "ai", "common", "contracts", "tui"],
	ai: ["contracts", "telemetry"],
	"coding-agent": ["agent", "ai", "common", "contracts", "tui", "webview"],
	contracts: [],
	telemetry: [],
	tui: [],
	webview: ["contracts"],
};

export function checkPackageBoundaries(
	packages,
	sources,
	policy = PACKAGE_POLICY,
	hostImportBaseline = HOST_IMPORT_BASELINE,
	layerRules = LAYER_RULES,
) {
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
	const layerEdges = new Set();
	for (const source of sources) {
		const manifest = packages[source.package];
		for (const specifier of source.imports) {
			let target = names.get(
				specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0],
			);
			let reached = specifier;
			if (specifier.startsWith(".")) {
				reached = path.posix.normalize(path.posix.join(source.package, path.posix.dirname(source.path), specifier));
				const resolved = reached.split("/")[0];
				if (packages[resolved] && resolved !== source.package) {
					target = resolved;
					if (unit(source.package) !== unit(target))
						issues.push(`relative package import: ${source.package}/${source.path} -> ${specifier}`);
				}
			}
			// A layer may not reach the layer above it, except through files its baseline already lists.
			for (const rule of layerRules) {
				if (`${source.package}/${source.path}`.startsWith(rule.from) && reached.startsWith(rule.to)) {
					layerEdges.add(`${rule.name}: ${source.package}/${source.path}`);
					if (!rule.baseline.includes(`${source.package}/${source.path}`))
						issues.push(`${rule.name}: ${source.package}/${source.path} -> ${reached} (not in its baseline)`);
				}
			}
			// A hosted workspace compiles into its host, but may only reach host files already in the baseline.
			if (target && target === unit(source.package) && target !== source.package) {
				if (!(hostImportBaseline[source.package] ?? []).includes(reached.replace(/\.js$/, ".ts")))
					issues.push(
						`hosted workspace reaches host internals: ${source.package}/${source.path} -> ${reached} (not in HOST_IMPORT_BASELINE)`,
					);
			}
			// Hosted workspaces compiled into one host may reach each other only along their policy edges.
			if (
				target &&
				manifest.octocodeSource &&
				target !== source.package &&
				target !== unit(target) &&
				unit(target) === unit(source.package) &&
				!(policy[source.package] ?? []).includes(target)
			)
				issues.push(`forbidden import: ${source.package}/${source.path} -> ${target}`);
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
	// A baseline entry that no longer imports its layer is stale: the ratchet only moves down. A rule applies once the
	// scan contains files of its layer.
	for (const rule of layerRules)
		for (const file of rule.baseline)
			if (
				sources.some((source) => `${source.package}/${source.path}`.startsWith(rule.from)) &&
				!layerEdges.has(`${rule.name}: ${file}`)
			)
				issues.push(`${rule.name}: ${file} no longer imports ${rule.to} (remove it from its baseline)`);
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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Private source workspaces compile into their declared host, not into separately installed packages. */
export function sourceWorkspaceGroups(packages) {
	const hosts = new Map(Object.keys(packages).map((name) => [name, name]));
	const issues = [];
	const mounts = new Set();
	for (const [name, manifest] of Object.entries(packages)) {
		const source = manifest.octocodeSource;
		if (!source) continue;
		const host = packages[source.host];
		if (
			manifest.private !== true ||
			!host ||
			host.octocodeSource ||
			source.host === name ||
			typeof source.mount !== "string" ||
			!/^[a-z][a-z0-9-]*$/.test(source.mount) ||
			host.devDependencies?.[manifest.name] !== "workspace:*"
		) {
			issues.push(
				`invalid source workspace: ${name} must be private, have a direct host and safe mount, and be its host's workspace devDependency`,
			);
			continue;
		}
		const key = `${source.host}/${source.mount}`;
		if (mounts.has(key)) {
			issues.push(`duplicate source workspace mount: ${key}`);
			continue;
		}
		mounts.add(key);
		hosts.set(name, source.host);
		const runtime = { ...host.dependencies, ...host.peerDependencies, ...host.optionalDependencies };
		if (Object.hasOwn(runtime, manifest.name))
			issues.push(`private source workspace is a runtime dependency: ${source.host} -> ${name}`);
		for (const [dependency, version] of Object.entries({
			...manifest.dependencies,
			...manifest.peerDependencies,
			...manifest.optionalDependencies,
		})) {
			if (runtime[dependency] !== version)
				issues.push(`source workspace dependency must be shipped by its host: ${name} -> ${dependency}@${version}`);
		}
	}
	return { hosts, issues };
}

export function readWorkspacePackages(root) {
	return Object.fromEntries(
		readdirSync(join(root, "packages"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => {
				try {
					return [[entry.name, JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8"))]];
				} catch (error) {
					if (error.code === "ENOENT") return [];
					throw error;
				}
			}),
	);
}

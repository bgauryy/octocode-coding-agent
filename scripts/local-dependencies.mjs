import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function validateLocalDependencies(packageDirectory) {
	const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
	const local = Object.entries(manifest.dependencies ?? {}).filter(([, specifier]) => /^(file|link):/.test(specifier));
	for (const [name, specifier] of local) {
		const expectedDirectory = resolve(packageDirectory, specifier.replace(/^(file|link):/, ""));
		const dependency = JSON.parse(readFileSync(join(expectedDirectory, "package.json"), "utf8"));
		if (dependency.name !== name) {
			throw new Error(`Local dependency ${name} resolves to package ${dependency.name}`);
		}
		let installedDirectory;
		for (let directory = packageDirectory; ; directory = dirname(directory)) {
			const candidate = join(directory, "node_modules", name);
			if (existsSync(candidate)) {
				installedDirectory = candidate;
				break;
			}
			if (dirname(directory) === directory) break;
		}
		if (!installedDirectory || realpathSync(installedDirectory) !== realpathSync(expectedDirectory)) {
			throw new Error(`Local dependency ${name} is not installed from ${expectedDirectory}; run yarn install`);
		}
		const bins = typeof dependency.bin === "string" ? [dependency.bin] : Object.values(dependency.bin ?? {});
		if (bins.length === 0) throw new Error(`Local dependency ${name} declares no CLI executable`);
		for (const bin of bins) {
			const entry = resolve(expectedDirectory, bin);
			const localPath = relative(expectedDirectory, entry);
			if (isAbsolute(localPath) || localPath.startsWith("..") || !existsSync(entry)) {
				throw new Error(`Local dependency ${name} CLI is missing or outside its package: ${bin}`);
			}
		}
	}
	return local.map(([name]) => name);
}

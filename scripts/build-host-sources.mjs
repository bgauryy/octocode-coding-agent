import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspacePackages, sourceWorkspaceGroups } from "./source-workspaces.mjs";
import { execYarnSync } from "./yarn-command.mjs";
import { rewriteModuleSpecifiers } from "./module-specifiers.mjs";

const inside = (file, root) => file === root || file.startsWith(`${root}${sep}`);
const files = (folder) =>
	readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const file = join(folder, entry.name);
		return entry.isDirectory() ? files(file) : [file];
	});

/** Stage one compilation tree while retaining one checked-in owner for every source file. */
export function stageHostSources(root, host, stage) {
	const packages = readWorkspacePackages(root);
	const { hosts, issues } = sourceWorkspaceGroups(packages);
	if (issues.length) throw new Error(issues.join("\n"));
	const hostDir = join(root, "packages", host);
	const mappings = [{ source: join(hostDir, "src"), target: join(stage, "src") }];
	for (const [name, owner] of hosts) {
		if (name === host || owner !== host) continue;
		const mount = packages[name].octocodeSource.mount;
		if (existsSync(join(hostDir, "src", mount))) throw new Error(`Source mount already exists: ${host}/src/${mount}`);
		mappings.push({ source: join(root, "packages", name, "src"), target: join(stage, "src", mount) });
	}
	const relocate = (file) => {
		const mapping = mappings.find((mapping) => inside(file, mapping.source));
		return mapping ? join(mapping.target, relative(mapping.source, file)) : file;
	};
	for (const mapping of mappings) {
		for (const file of files(mapping.source)) {
			const destination = relocate(file);
			mkdirSync(dirname(destination), { recursive: true });
			if (!/\.[cm]?[jt]sx?$/.test(file)) {
				cpSync(file, destination);
				continue;
			}
			const source = readFileSync(file, "utf8");
			const rewritten = rewriteModuleSpecifiers(source, file, (specifier) => {
				if (!specifier.startsWith(".")) return specifier;
				const target = relocate(resolve(dirname(file), specifier));
				let path = relative(dirname(destination), target).split(sep).join("/");
				if (!path.startsWith(".")) path = `./${path}`;
				return path;
			});
			writeFileSync(destination, rewritten);
		}
	}
	writeFileSync(
		join(stage, "tsconfig.json"),
		JSON.stringify({
			extends: join(hostDir, "tsconfig.build.json"),
			compilerOptions: { rootDir: join(stage, "src"), outDir: join(hostDir, "dist") },
			include: ["src/**/*.ts", "src/**/*.d.ts"],
		}),
	);
	return mappings;
}

export function buildHostSources(hostDir) {
	const root = resolve(hostDir, "../..");
	const stage = mkdtempSync(join(hostDir, ".build-sources-"));
	try {
		const mappings = stageHostSources(root, basename(hostDir), stage);
		execYarnSync(["exec", "tsc", "-p", join(stage, "tsconfig.json")], { cwd: hostDir, stdio: "inherit" });
		// Maps point back to the canonical sources, never the disposable compilation tree.
		for (const file of files(join(hostDir, "dist")).filter((file) => file.endsWith(".map"))) {
			const map = JSON.parse(readFileSync(file, "utf8"));
			map.sources = map.sources.map((source) => {
				const absolute = resolve(dirname(file), source);
				const mapping = [...mappings].reverse().find((mapping) => inside(absolute, mapping.target));
				return mapping
					? relative(dirname(file), join(mapping.source, relative(mapping.target, absolute)))
							.split(sep)
							.join("/")
					: source;
			});
			writeFileSync(file, JSON.stringify(map));
		}
		for (const mapping of mappings.slice(1)) {
			const licenses = join(dirname(mapping.source), "LICENSES");
			if (existsSync(licenses))
				cpSync(licenses, join(hostDir, "dist/licenses", basename(mapping.target)), { recursive: true });
		}
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildHostSources(process.cwd());

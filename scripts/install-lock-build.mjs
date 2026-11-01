// Builds the installer manifest and lock from the root npm lockfile and the internal workspaces.

import { join } from "node:path";
import {
	copyLockEntry,
	copyPackageJsonEntry,
	packageDependencies,
	readJson,
	registryTarballUrl,
	resolveExternalDependency,
	sortedObject,
	sortedPackageEntry,
} from "./install-lock-entries.mjs";
import { internalPackagePrefix, validateGeneratedFiles } from "./install-lock-validate.mjs";

const installPackageName = "@octocodeai/octocodecode-install";

function getInternalWorkspaces(repoRoot, lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}
		if (!entry.name.startsWith(internalPackagePrefix)) {
			continue;
		}

		workspaces.set(entry.name, {
			lockPath,
			packageJson: readJson(join(repoRoot, lockPath, "package.json")),
		});
	}

	return workspaces;
}

function addInternalWorkspace(installLockPackages, addedPaths, queue, name, workspace) {
	const packageJson = workspace.packageJson;
	const outputPath = `node_modules/${name}`;
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	installLockPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	for (const dependencyName of Object.keys(packageDependencies(packageJson))) {
		queue.push({
			name: dependencyName,
			sourceFrom: workspace.lockPath,
			sourceBase: workspace.lockPath,
			outputBase: outputPath,
		});
	}
}

function addExternalPackage(lockPackages, installLockPackages, addedPaths, queue, item) {
	const sourceLockPath = resolveExternalDependency(lockPackages, item.name, item.sourceFrom);
	const outputLockPath =
		item.sourceBase && sourceLockPath.startsWith(`${item.sourceBase}/`)
			? [item.outputBase, sourceLockPath.slice(item.sourceBase.length + 1)].filter(Boolean).join("/")
			: sourceLockPath;
	if (addedPaths.has(outputLockPath)) {
		return;
	}

	const entry = lockPackages[sourceLockPath];
	installLockPackages[outputLockPath] = copyLockEntry(entry);
	addedPaths.add(outputLockPath);

	for (const dependencyName of Object.keys(packageDependencies(entry))) {
		queue.push({
			name: dependencyName,
			sourceFrom: sourceLockPath,
			sourceBase: item.sourceBase,
			outputBase: item.outputBase,
		});
	}
}

function createInstallerPackageJson(codingAgentPackage) {
	const packageJson = {
		name: installPackageName,
		version: codingAgentPackage.version,
		private: true,
		description: "Lockfile root used by the Octocode installer and updater.",
		dependencies: {
			[codingAgentPackage.name]: codingAgentPackage.version,
		},
	};
	if (codingAgentPackage.overrides) {
		packageJson.overrides = codingAgentPackage.overrides;
	}
	if (codingAgentPackage.engines) {
		packageJson.engines = codingAgentPackage.engines;
	}
	return packageJson;
}

function createRootLockEntry(installerPackageJson) {
	const entry = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		dependencies: installerPackageJson.dependencies,
	};
	if (installerPackageJson.engines) {
		entry.engines = installerPackageJson.engines;
	}
	return sortedPackageEntry(entry);
}

export function generateInstallLock({ repoRoot, codingAgentDir, rootLockfilePath }) {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const installerPackageJson = createInstallerPackageJson(codingAgentPackage);
	const internalWorkspaces = getInternalWorkspaces(repoRoot, lockPackages);
	const installLockPackages = {
		"": createRootLockEntry(installerPackageJson),
	};
	const addedPaths = new Set([""]);
	const internalNames = new Set();
	const queue = Object.keys(packageDependencies(installerPackageJson)).map((name) => ({
		name,
		sourceFrom: "",
	}));

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}

		const workspace = internalWorkspaces.get(item.name);
		if (workspace) {
			const outputPath = `node_modules/${item.name}`;
			internalNames.add(item.name);
			if (!addedPaths.has(outputPath)) {
				addInternalWorkspace(installLockPackages, addedPaths, queue, item.name, workspace);
			}
			continue;
		}

		addExternalPackage(lockPackages, installLockPackages, addedPaths, queue, item);
	}

	const installLock = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(installLockPackages),
	};

	validateGeneratedFiles(installerPackageJson, installLock, internalNames);
	return { installerPackageJson, installLock };
}

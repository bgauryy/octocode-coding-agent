import { isAbsolute, posix, win32 } from "node:path";

const sections = ["dependencies", "optionalDependencies", "peerDependencies"];
const localSpec = /^(?:file:|link:|workspace:|\.\.?[/\\]|[/\\])/i;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isLocal(spec) {
	return localSpec.test(spec) || isAbsolute(spec) || win32.isAbsolute(spec);
}

export function assertRegistrySpecifier(name, spec) {
	if (typeof spec !== "string" || isLocal(spec)) throw new Error(`Local dependency ${name}: ${String(spec)}`);
	// Registry semver/ranges only. Tarball URLs, Git and aliases need separately reviewed mappings.
	if (!/^[0-9A-Za-z.*+^~<>=|\s-]+$/.test(spec) || /^(?:https?:|git[+:]|npm:)/i.test(spec)) {
		throw new Error(`Unsupported registry dependency ${name}: ${spec}`);
	}
}

export function stageRegistryManifest(source, releaseMap, workspaceVersions = {}) {
	const staged = structuredClone(source);
	for (const section of sections) {
		for (const [name, spec] of Object.entries(staged[section] ?? {})) {
			if (isLocal(spec)) {
				const mapping = releaseMap[name];
				if (!mapping) {
					if (/^link:/i.test(spec)) throw new Error(`Missing reviewed release mapping for ${name}`);
					throw new Error(`Local dependency ${name}: ${spec}`);
				}
				if (
					!exactVersion.test(mapping.version) ||
					!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(mapping.integrity) ||
					typeof mapping.sourceRevision !== "string" ||
					mapping.sourceRevision.length < 8
				) {
					throw new Error(`Incomplete reviewed release mapping for ${name}`);
				}
				staged[section][name] = mapping.version;
			} else {
				assertRegistrySpecifier(name, spec);
			}
			if (Object.hasOwn(workspaceVersions, name) && staged[section][name] !== workspaceVersions[name]) {
				throw new Error(
					`Workspace dependency ${name} must be ${workspaceVersions[name]}, found ${staged[section][name]}`,
				);
			}
		}
	}
	return staged;
}

export function createInstallerManifest(agent) {
	const manifest = {
		name: "@octocodeai/octocodecode-install",
		version: agent.version,
		private: true,
		dependencies: { [agent.name]: agent.version },
	};
	if (agent.overrides) manifest.overrides = structuredClone(agent.overrides);
	if (agent.engines) manifest.engines = structuredClone(agent.engines);
	return manifest;
}

function packageName(lockPath) {
	const parts = lockPath.slice(lockPath.lastIndexOf("node_modules/") + 13).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function dependencyPath(packages, fromPath, name) {
	let current = fromPath;
	while (true) {
		const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
		if (Object.hasOwn(packages, candidate)) return candidate;
		if (!current) return undefined;
		const parent = posix.dirname(current);
		current = parent === "." ? "" : parent;
	}
}

/** Validate a dedicated npm resolution lock, never the development Yarn graph. */
export function validateRegistryLock(lock, { registry, directName, directVersion, allowInstallScripts = [] }) {
	if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
		throw new Error("Dedicated installer lock must be npm lockfileVersion 3");
	}
	const root = lock.packages[""];
	if (!root || root.dependencies?.[directName] !== directVersion || Object.keys(root.dependencies).length !== 1) {
		throw new Error(`Dedicated installer root must depend only on ${directName}@${directVersion}`);
	}
	const registryUrl = new URL(registry);
	if (
		registryUrl.protocol !== "https:" &&
		registryUrl.hostname !== "127.0.0.1" &&
		registryUrl.hostname !== "localhost"
	) {
		throw new Error(`Registry must use HTTPS or local fixture: ${registry}`);
	}
	const allowScripts = new Set(allowInstallScripts);
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path && !path.includes("node_modules/")) throw new Error(`Unexpected installer lock entry: ${path}`);
		if (entry.link || entry.dev || entry.devOptional || entry.extraneous)
			throw new Error(`Nonproduction/link lock entry: ${path}`);
		if (path) {
			const name = packageName(path);
			if (typeof entry.resolved !== "string" || isLocal(entry.resolved))
				throw new Error(`local resolved value for ${name}: ${entry.resolved}`);
			let resolved;
			try {
				resolved = new URL(entry.resolved);
			} catch {
				throw new Error(`Invalid registry URL for ${name}: ${entry.resolved}`);
			}
			if (resolved.origin !== registryUrl.origin || !resolved.pathname.startsWith(registryUrl.pathname)) {
				throw new Error(`Unexpected registry for ${name}: ${entry.resolved}`);
			}
			if (typeof entry.integrity !== "string" || !/^sha512-/.test(entry.integrity))
				throw new Error(`Missing integrity for ${name}`);
			if (entry.hasInstallScript && !allowScripts.has(`${name}@${entry.version}`))
				throw new Error(`Unreviewed install script for ${name}@${entry.version}`);
		}
		for (const section of sections) {
			for (const [name, spec] of Object.entries(entry[section] ?? {})) {
				assertRegistrySpecifier(name, spec);
				if (section === "peerDependencies" && entry.peerDependenciesMeta?.[name]?.optional === true) continue;
				if (!dependencyPath(lock.packages, path, name))
					throw new Error(`Dependency ${name} missing from installer lock (${path || "root"})`);
			}
		}
	}
	const direct = dependencyPath(lock.packages, "", directName);
	if (!direct || lock.packages[direct].version !== directVersion)
		throw new Error(`Missing ${directName}@${directVersion} in installer lock`);
	return true;
}

export function validateReleaseMetadata(name, mapping, metadata, registry) {
	if (metadata?.version !== mapping.version || metadata.dist?.integrity !== mapping.integrity) {
		throw new Error(`Registry metadata mismatch for ${name}@${mapping.version}`);
	}
	const tarball = new URL(metadata.dist.tarball);
	const expected = new URL(registry);
	if (tarball.origin !== expected.origin || !tarball.pathname.startsWith(expected.pathname)) {
		throw new Error(`Unexpected registry tarball for ${name}: ${tarball}`);
	}
}

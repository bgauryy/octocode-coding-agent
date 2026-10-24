import { isAbsolute, posix, win32 } from "node:path";
import semver from "semver";

const sections = ["dependencies", "optionalDependencies", "peerDependencies"];
const localSpec = /^(?:file:|link:|workspace:|\.\.?[/\\]|[/\\])/i;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isLocal(spec) {
	return localSpec.test(spec) || isAbsolute(spec) || win32.isAbsolute(spec);
}

function assertRegistrySpecifier(name, spec) {
	if (typeof spec !== "string" || isLocal(spec)) throw new Error(`Local dependency ${name}: ${String(spec)}`);
	// Registry semver/ranges only. Tarball URLs, Git and aliases need separately reviewed mappings.
	if (!semver.validRange(spec)) {
		throw new Error(`Unsupported registry dependency ${name}: ${spec}`);
	}
}

function validIntegrity(integrity) {
	if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) return false;
	const encoded = integrity.slice(7);
	return Buffer.from(encoded, "base64").length === 64 && Buffer.from(encoded, "base64").toString("base64") === encoded;
}

export function stageRegistryManifest(source, releaseMap, workspaceVersions = {}) {
	for (const name of Object.keys(releaseMap)) {
		if (Object.hasOwn(workspaceVersions, name)) throw new Error(`Reviewed mapping shadows workspace package ${name}`);
		if (Object.hasOwn(releaseMap[name] ?? {}, "name"))
			throw new Error(`Reviewed mapping value must not set name: ${name}`);
	}
	const staged = structuredClone(source);
	for (const section of sections) {
		for (const [name, spec] of Object.entries(staged[section] ?? {})) {
			if (isLocal(spec)) {
				if (!/^link:/i.test(spec)) throw new Error(`Local dependency ${name}: ${spec}`);
				const mapping = releaseMap[name];
				if (!mapping) throw new Error(`Missing reviewed release mapping for ${name}`);
				if (
					!exactVersion.test(mapping.version) ||
					!validIntegrity(mapping.integrity) ||
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
export function validateRegistryLock(
	lock,
	{ registry, directName, directVersion, allowInstallScripts = [], reviewedPackages = {}, directTarball },
) {
	if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
		throw new Error("Dedicated installer lock must be npm lockfileVersion 3");
	}
	const root = lock.packages[""];
	if (
		!root ||
		root.dependencies?.[directName] !== (directTarball ?? directVersion) ||
		Object.keys(root.dependencies ?? {}).length !== 1
	) {
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
			if (
				typeof entry.resolved !== "string" ||
				(isLocal(entry.resolved) &&
					!(
						directTarball &&
						name === directName &&
						path === `node_modules/${directName}` &&
						entry.resolved === directTarball
					))
			)
				throw new Error(`local resolved value for ${name}: ${entry.resolved}`);
			if (entry.resolved !== directTarball || !directTarball || name !== directName) {
				let resolved;
				try {
					resolved = new URL(entry.resolved);
				} catch {
					throw new Error(`Invalid registry URL for ${name}: ${entry.resolved}`);
				}
				if (resolved.origin !== registryUrl.origin || !resolved.pathname.startsWith(registryUrl.pathname)) {
					throw new Error(`Unexpected registry for ${name}: ${entry.resolved}`);
				}
			}
			if (!validIntegrity(entry.integrity)) throw new Error(`Missing or invalid integrity for ${name}`);
			if (
				reviewedPackages[name] &&
				(entry.version !== reviewedPackages[name].version || entry.integrity !== reviewedPackages[name].integrity)
			) {
				throw new Error(`Reviewed registry metadata mismatch for ${name}@${entry.version}`);
			}
			if (entry.hasInstallScript && !allowScripts.has(`${name}@${entry.version}`))
				throw new Error(`Unreviewed install script for ${name}@${entry.version}`);
		}
		for (const section of sections) {
			for (const [name, spec] of Object.entries(entry[section] ?? {})) {
				if (!(path === "" && directTarball && name === directName && spec === directTarball))
					assertRegistrySpecifier(name, spec);
				const resolvedPath = dependencyPath(lock.packages, path, name);
				if (section === "peerDependencies" && entry.peerDependenciesMeta?.[name]?.optional === true && !resolvedPath)
					continue;
				if (!resolvedPath) throw new Error(`Dependency ${name} missing from installer lock (${path || "root"})`);
				if (
					!(path === "" && directTarball && name === directName) &&
					!semver.satisfies(lock.packages[resolvedPath].version, spec)
				) {
					throw new Error(`Dependency ${name}@${spec} resolves to ${lock.packages[resolvedPath].version}`);
				}
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

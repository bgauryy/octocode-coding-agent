import assert from "node:assert/strict";
import test from "node:test";
import { createInstallerManifest, stageRegistryManifest, validateRegistryLock } from "./registry-release.mjs";
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

const releaseMap = {
	"@octocodeai/octocode-native": {
		version: "20.2.0",
		sourceRevision: "abcdef123456",
		integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
	},
	octocode: {
		version: "20.2.0",
		sourceRevision: "abcdef123456",
		integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
	},
	"octocode-mcp": {
		version: "20.2.0",
		sourceRevision: "abcdef123456",
		integrity: `sha512-${Buffer.alloc(64, 3).toString("base64")}`,
	},
};

const source = {
	name: "@octocodeai/octocodecode",
	version: "1.3.0",
	dependencies: {
		"@octocodeai/octocode-native": "link:../../../octocode/packages/octocode-native",
		octocode: "link:../../../octocode/packages/octocode",
		"octocode-mcp": "link:../../../octocode/packages/octocode-mcp",
		"@octocodeai/octocode-ai": "1.3.0",
	},
	peerDependencies: { "optional-peer": "2.0.0" },
	peerDependenciesMeta: { "optional-peer": { optional: true } },
	overrides: { protobufjs: "7.6.6" },
};

test("stages only explicitly mapped sibling links without changing the source manifest", () => {
	const before = structuredClone(source);
	const staged = stageRegistryManifest(source, releaseMap, { "@octocodeai/octocode-ai": "1.3.0" });
	assert.equal(staged.dependencies.octocode, "20.2.0");
	assert.equal(staged.dependencies["octocode-mcp"], "20.2.0");
	assert.deepEqual(source, before);
	assert.deepEqual(createInstallerManifest(staged).overrides, { protobufjs: "7.6.6" });
	assert.equal(createInstallerManifest(staged).dependencies[source.name], source.version);
});

test("rejects a reviewed sibling mapping that shadows a staged workspace package", () => {
	assert.throws(
		() =>
			stageRegistryManifest(
				source,
				{ ...releaseMap, "@octocodeai/octocode-ai": releaseMap.octocode },
				{ "@octocodeai/octocode-ai": "1.3.0" },
			),
		/Reviewed mapping shadows workspace.*octocode-ai/,
	);
});

test("rejects mapping values that claim another package name", () => {
	assert.throws(
		() =>
			stageRegistryManifest(
				source,
				{ ...releaseMap, octocode: { ...releaseMap.octocode, name: "@octocodeai/octocode-ai" } },
				{ "@octocodeai/octocode-ai": "1.3.0" },
			),
		/Reviewed mapping value must not set name.*octocode/,
	);
});

test("fails closed for unmapped links, local protocols and wrong internal versions", () => {
	assert.throws(
		() => stageRegistryManifest(source, { ...releaseMap, octocode: undefined }, {}),
		/Missing reviewed release mapping.*octocode/,
	);
	assert.throws(
		() => stageRegistryManifest({ ...source, dependencies: { other: "file:../other" } }, releaseMap, {}),
		/Local dependency.*other/,
	);
	assert.throws(
		() => stageRegistryManifest({ ...source, dependencies: { octocode: "file:../octocode" } }, releaseMap, {}),
		/Local dependency.*octocode/,
	);
	assert.throws(
		() => stageRegistryManifest({ ...source, optionalDependencies: { other: "workspace:*" } }, releaseMap, {}),
		/Local dependency.*other/,
	);
	assert.throws(
		() => stageRegistryManifest({ ...source, peerDependencies: { other: "/absolute/path" } }, releaseMap, {}),
		/Local dependency.*other/,
	);
	assert.throws(
		() =>
			stageRegistryManifest({ ...source, dependencies: { "@octocodeai/octocode-ai": "1.2.0" } }, releaseMap, {
				"@octocodeai/octocode-ai": "1.3.0",
			}),
		/Workspace dependency.*1.2.0/,
	);
});

test("checks recursive dependencies, optional and nonoptional peers, registry origin and integrities", () => {
	const registry = "https://registry.npmjs.org";
	const lock = {
		lockfileVersion: 3,
		packages: {
			"": { dependencies: { "@octocodeai/octocodecode": "1.3.0" } },
			"node_modules/@octocodeai/octocodecode": {
				version: "1.3.0",
				resolved: `${registry}/cli.tgz`,
				integrity,
				dependencies: { child: "1.0.0" },
				optionalDependencies: { platform: "1.0.0" },
				peerDependencies: { peer: "1.0.0", optional: "1.0.0" },
				peerDependenciesMeta: { optional: { optional: true } },
			},
			"node_modules/child": {
				version: "1.0.0",
				resolved: `${registry}/child.tgz`,
				integrity,
				dependencies: { grandchild: "1.0.0" },
			},
			"node_modules/grandchild": { version: "1.0.0", resolved: `${registry}/grandchild.tgz`, integrity },
			"node_modules/platform": {
				version: "1.0.0",
				resolved: `${registry}/platform.tgz`,
				integrity,
				optional: true,
				os: ["darwin"],
			},
			"node_modules/peer": { version: "1.0.0", resolved: `${registry}/peer.tgz`, integrity },
		},
	};
	assert.doesNotThrow(() =>
		validateRegistryLock(lock, { registry, directName: source.name, directVersion: source.version }),
	);
	for (const [mutate, problem] of [
		[
			(copy) => {
				delete copy.packages["node_modules/grandchild"];
			},
			/grandchild.*missing/,
		],
		[
			(copy) => {
				delete copy.packages["node_modules/platform"];
			},
			/platform.*missing/,
		],
		[
			(copy) => {
				delete copy.packages["node_modules/peer"];
			},
			/peer.*missing/,
		],
		[
			(copy) => {
				copy.packages["node_modules/child"].resolved = "file:../child";
			},
			/local resolved.*child/,
		],
		[
			(copy) => {
				copy.packages["node_modules/child"].resolved = "https://fixture.example/child.tgz";
			},
			/Unexpected registry.*child/,
		],
		[
			(copy) => {
				delete copy.packages["node_modules/child"].integrity;
			},
			/integrity.*child/,
		],
		[
			(copy) => {
				copy.packages["node_modules/child"].dependencies.grandchild = "file:../grandchild";
			},
			/Local dependency.*grandchild/,
		],
		[
			(copy) => {
				copy.packages["node_modules/child"].version = "9.0.0";
			},
			/Dependency child@1.0.0 resolves to 9.0.0/,
		],
		[
			(copy) => {
				copy.packages["node_modules/@octocodeai/octocodecode"].dependencies.child = "^1.0.0";
				copy.packages["node_modules/child"].version = "1.1.0-beta.1";
			},
			/Dependency child@\^1.0.0 resolves to 1.1.0-beta.1/,
		],
		[
			(copy) => {
				copy.packages["node_modules/child"].integrity = "sha512-test";
			},
			/invalid integrity.*child/,
		],
		[
			(copy) => {
				copy.packages["node_modules/optional"] = { version: "9.0.0", resolved: `${registry}/optional.tgz`, integrity };
			},
			/Dependency optional@1.0.0 resolves to 9.0.0/,
		],
	]) {
		const copy = structuredClone(lock);
		mutate(copy);
		assert.throws(
			() => validateRegistryLock(copy, { registry, directName: source.name, directVersion: source.version }),
			problem,
		);
	}
});

test("permits only the direct candidate tarball path in a clean consumer lock", () => {
	const registry = "https://registry.npmjs.org";
	const directTarball = "file:/tmp/candidate.tgz";
	const lock = {
		lockfileVersion: 3,
		packages: {
			"": { dependencies: { [source.name]: directTarball } },
			[`node_modules/${source.name}`]: {
				version: source.version,
				resolved: directTarball,
				integrity,
				dependencies: { child: "1.0.0" },
			},
			"node_modules/child": { version: "1.0.0", resolved: `${registry}/child.tgz`, integrity },
		},
	};
	assert.doesNotThrow(() =>
		validateRegistryLock(lock, { registry, directName: source.name, directVersion: source.version, directTarball }),
	);
	lock.packages["node_modules/child"].resolved = "file:/tmp/child.tgz";
	assert.throws(
		() =>
			validateRegistryLock(lock, { registry, directName: source.name, directVersion: source.version, directTarball }),
		/local resolved.*child/,
	);
});

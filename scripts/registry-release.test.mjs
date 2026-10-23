import assert from "node:assert/strict";
import test from "node:test";
import { createInstallerManifest, stageRegistryManifest, validateRegistryLock } from "./registry-release.mjs";

const releaseMap = {
	"@octocodeai/octocode-native": {
		version: "20.2.0",
		sourceRevision: "abcdef123456",
		integrity: `sha512-${"a".repeat(86)}==`,
	},
	octocode: { version: "20.2.0", sourceRevision: "abcdef123456", integrity: `sha512-${"b".repeat(86)}==` },
	"octocode-mcp": { version: "20.2.0", sourceRevision: "abcdef123456", integrity: `sha512-${"c".repeat(86)}==` },
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
				integrity: "sha512-test",
				dependencies: { child: "1.0.0" },
				optionalDependencies: { platform: "1.0.0" },
				peerDependencies: { peer: "1.0.0", optional: "1.0.0" },
				peerDependenciesMeta: { optional: { optional: true } },
			},
			"node_modules/child": {
				version: "1.0.0",
				resolved: `${registry}/child.tgz`,
				integrity: "sha512-test",
				dependencies: { grandchild: "1.0.0" },
			},
			"node_modules/grandchild": { version: "1.0.0", resolved: `${registry}/grandchild.tgz`, integrity: "sha512-test" },
			"node_modules/platform": {
				version: "1.0.0",
				resolved: `${registry}/platform.tgz`,
				integrity: "sha512-test",
				optional: true,
				os: ["darwin"],
			},
			"node_modules/peer": { version: "1.0.0", resolved: `${registry}/peer.tgz`, integrity: "sha512-test" },
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
	]) {
		const copy = structuredClone(lock);
		mutate(copy);
		assert.throws(
			() => validateRegistryLock(copy, { registry, directName: source.name, directVersion: source.version }),
			problem,
		);
	}
});

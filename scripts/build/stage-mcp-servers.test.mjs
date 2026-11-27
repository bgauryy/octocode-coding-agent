import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { hostMcpPackages, stageHostMcpServers } from "./stage-mcp-servers.mjs";

const write = (file, text) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};
/** Every file under `dir`, as `npm pack` would list a package without a `files` field. */
const allFiles = (dir) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !relative(dir, join(entry.parentPath, entry.name)).startsWith("node_modules"))
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)));

test("stages the host-dependency server with its dependencies for one platform, from what the host resolves", () => {
	const root = mkdtempSync(join(tmpdir(), "stage-mcp-"));
	try {
		const defaultConfig = join(root, "default_mcp_config.json");
		write(
			defaultConfig,
			JSON.stringify({
				servers: {
					octocode: { install: { npm: "octocode-mcp", hostDependency: true } },
					other: { install: { npm: "other-mcp" } },
					plain: { command: "x" },
				},
				agents: {},
			}),
		);
		assert.deepEqual(hostMcpPackages(defaultConfig), ["octocode-mcp"]);

		const host = join(root, "host");
		write(join(host, "package.json"), "{}");
		const server = join(host, "node_modules", "octocode-mcp");
		write(
			join(server, "package.json"),
			JSON.stringify({
				name: "octocode-mcp",
				version: "20.2.0",
				dependencies: { "fake-tsgo": "1" },
				optionalDependencies: {
					"@octocodeai/octocode-native-darwin-arm64": "1",
					"@octocodeai/octocode-native-linux-x64-gnu": "1",
					"@octocodeai/octocode-native-linux-x64-musl": "1",
				},
			}),
		);
		write(join(server, "dist", "index.js"), "#!/usr/bin/env node\n");
		// A production dependency that ships its executable as per-platform optional packages, as tsgo does.
		const tsgo = join(server, "node_modules", "fake-tsgo");
		write(
			join(tsgo, "package.json"),
			JSON.stringify({
				name: "fake-tsgo",
				optionalDependencies: { "fake-tsgo-darwin-arm64": "1", "fake-tsgo-linux-x64": "1" },
			}),
		);
		write(
			join(tsgo, "node_modules", "fake-tsgo-darwin-arm64", "package.json"),
			JSON.stringify({ name: "fake-tsgo-darwin-arm64", os: ["darwin"], cpu: ["arm64"] }),
		);
		write(join(tsgo, "node_modules", "fake-tsgo-darwin-arm64", "lib", "tsgo"), "binary");
		const nativePackage = (suffix, manifest) => {
			const dir = join(server, "node_modules", "@octocodeai", `octocode-native-${suffix}`);
			write(
				join(dir, "package.json"),
				JSON.stringify({ name: `@octocodeai/octocode-native-${suffix}`, files: ["octocode"], ...manifest }),
			);
			return dir;
		};
		const native = nativePackage("darwin-arm64", { os: ["darwin"], cpu: ["arm64"] });
		write(join(native, "octocode"), "binary");
		chmodSync(join(native, "octocode"), 0o755);
		// Linked from a workspace that never built it: the manifest is here, its binary is not.
		nativePackage("linux-x64-gnu", { os: ["linux"], cpu: ["x64"], libc: ["glibc"] });
		nativePackage("linux-x64-musl", { os: ["linux"], cpu: ["x64"], libc: ["musl"] });

		const out = join(root, "out");
		const darwin = stageHostMcpServers(out, "darwin-arm64", {
			packageDir: host,
			defaultConfig,
			listFiles: allFiles,
		});
		assert.deepEqual(darwin, {
			staged: ["octocode-mcp", "fake-tsgo", "fake-tsgo-darwin-arm64", "@octocodeai/octocode-native-darwin-arm64"],
			missing: [],
		});
		assert.ok(statSync(join(out, "node_modules", "fake-tsgo-darwin-arm64", "lib", "tsgo")).isFile());
		assert.ok(statSync(join(out, "node_modules", "octocode-mcp", "dist", "index.js")).isFile());
		const binary = statSync(join(out, "node_modules", "@octocodeai", "octocode-native-darwin-arm64", "octocode"));
		assert.equal(binary.mode & 0o111, 0o111);

		// Another platform's packages are not installed here: reported, and the server is still staged.
		const linux = stageHostMcpServers(join(root, "linux"), "linux-x64", {
			packageDir: host,
			defaultConfig,
			listFiles: allFiles,
		});
		assert.deepEqual(linux, {
			staged: ["octocode-mcp", "fake-tsgo"],
			// The glibc package is the target's (not the musl one), and it is not built here.
			missing: ["fake-tsgo-linux-x64", "@octocodeai/octocode-native-linux-x64-gnu"],
		});

		assert.throws(
			() =>
				stageHostMcpServers(out, "darwin-arm64", {
					packageDir: root,
					defaultConfig,
					listFiles: allFiles,
				}),
			/octocode-mcp does not resolve/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

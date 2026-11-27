import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const SANDBOX_RUNTIME = "@octocodeai/octocode-sandbox-runtime";

/**
 * The command-sandbox library's prebuilt helpers the bundle needs, relative to its `vendor/` folder: the Linux seccomp
 * filter per architecture and the JVM proxy agent. Compiled into the bundle, the library looks for them in `vendor/`
 * beside the bundle file first (`getApplySeccompBinaryPath`, `getJavaProxyAgentJarPathAsync`). Its Windows helper is
 * left out: Octocode sandboxes commands on macOS and Linux only.
 */
export const SANDBOX_VENDOR_FILES = [
	"seccomp/x64/apply-seccomp",
	"seccomp/arm64/apply-seccomp",
	"java-proxy-agent/srt-proxy-agent.jar",
];

/**
 * Copy the helpers of the library `packageDirectory` resolves into `bundleDirectory/vendor/`, modes kept (the seccomp
 * helpers are executables). Throws naming any helper the library lacks: without them Linux commands lose the seccomp
 * filter and JVMs ignore the proxy.
 */
export function copySandboxVendor(packageDirectory, bundleDirectory) {
	const manifest = createRequire(join(packageDirectory, "package.json")).resolve(`${SANDBOX_RUNTIME}/package.json`);
	const vendor = join(dirname(manifest), "vendor");
	const missing = SANDBOX_VENDOR_FILES.filter((file) => !existsSync(join(vendor, file)));
	if (missing.length > 0)
		throw new Error(
			`${SANDBOX_RUNTIME} lacks its prebuilt helpers (${missing.join(", ")} under ${vendor}); add them as its FORK.md describes`,
		);
	for (const file of SANDBOX_VENDOR_FILES) cpSync(join(vendor, file), join(bundleDirectory, "vendor", file));
	return SANDBOX_VENDOR_FILES.length;
}

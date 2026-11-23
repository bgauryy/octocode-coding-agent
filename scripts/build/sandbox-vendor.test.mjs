import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SANDBOX_RUNTIME, SANDBOX_VENDOR_FILES, copySandboxVendor } from "./sandbox-vendor.mjs";

function library(t, files) {
	const root = mkdtempSync(join(tmpdir(), "sandbox-vendor-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const host = join(root, "host");
	const installed = join(host, "node_modules", SANDBOX_RUNTIME);
	mkdirSync(installed, { recursive: true });
	writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host" }));
	writeFileSync(join(installed, "package.json"), JSON.stringify({ name: SANDBOX_RUNTIME, main: "./dist/index.js" }));
	for (const file of files) {
		const path = join(installed, "vendor", file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, file);
		if (!file.endsWith(".jar")) chmodSync(path, 0o755);
	}
	return { host, bundle: join(root, "dist", "bundle") };
}

test("copies every helper beside the bundle, executables kept executable", (t) => {
	const { host, bundle } = library(t, SANDBOX_VENDOR_FILES);
	assert.equal(copySandboxVendor(host, bundle), SANDBOX_VENDOR_FILES.length);
	for (const file of SANDBOX_VENDOR_FILES) assert.equal(readFileSync(join(bundle, "vendor", file), "utf8"), file);
	assert.equal(statSync(join(bundle, "vendor/seccomp/x64/apply-seccomp")).mode & 0o111, 0o111);
});

test("fails naming each helper the library lacks", (t) => {
	const { host, bundle } = library(t, ["seccomp/x64/apply-seccomp"]);
	assert.throws(
		() => copySandboxVendor(host, bundle),
		/lacks its prebuilt helpers \(seccomp\/arm64\/apply-seccomp, java-proxy-agent\/srt-proxy-agent\.jar under /,
	);
});

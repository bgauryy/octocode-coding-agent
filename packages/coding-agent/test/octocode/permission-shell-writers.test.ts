import { beforeAll, describe, expect, it } from "vitest";
import { shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";

beforeAll(shellParserReady);

const effect = (command: string) => {
	const { writes, areas, opaque, uncertain } = shellMutation(command);
	return { writes, areas, opaque, uncertain };
};
/** Whether a read-only role or isolated tree sees any change in the command. */
const changes = (command: string): boolean => {
	const { writes, areas, opaque, uncertain } = effect(command);
	return writes.length > 0 || areas.length > 0 || opaque.length > 0 || uncertain;
};

describe("programs that write without a redirection", () => {
	it.each([
		["gzip f", ["f"]],
		["gzip -9 f g", ["f", "g"]],
		["gunzip f.gz", ["f.gz"]],
		["gzip -d f.gz", ["f.gz"]],
		["bzip2 f", ["f"]],
		["xz -T 4 f", ["f"]],
		["zstd f", ["f"]],
		["zstd f -o out.zst", ["f", "out.zst"]],
		["sponge f", ["f"]],
		["split f", ["x"]],
		["split -l 10 f out.", ["out."]],
		["csplit f 1", ["xx"]],
		["csplit -f part f 1", ["part"]],
		["shuf -o f a", ["f"]],
		["shuf --output=f a", ["f"]],
		["openssl enc -aes-256-cbc -in a -out b", ["b"]],
		["openssl req -new -keyout k.pem -out c.csr", ["k.pem", "c.csr"]],
		["less -o f a", ["f"]],
		["xxd a b", ["b"]],
		["xxd -r -c 8 a b", ["b"]],
		["ditto a b", ["b"]],
		["zip x.zip a", ["x.zip"]],
		["zip -r x a", ["x", "x.zip"]],
		["7z a x a", ["x", "x.7z"]],
		["7z a -tzip x.zip a", ["x.zip"]],
		["ar r x.a y", ["x.a"]],
		["ar -rc x.a y", ["x.a"]],
		["ar rb m x.a y", ["x.a"]],
		["cpio -o -O x.cpio", ["x.cpio"]],
		["strip f", ["f"]],
		["strip -o out f", ["out"]],
		["script f", ["f"]],
		["script", ["typescript"]],
		["sudo gzip f", ["f"]],
		["cd pkg && gzip f", ["./pkg/f"]],
	])("%s writes %j", (command, writes) => {
		expect(effect(command).writes).toEqual(writes);
	});

	it.each(["7z x a.7z", "7z x a.7z -oout", "cpio -i", "ar x x.a", "ditto -x a.zip"])(
		"%s extracts into a directory",
		(command) => {
			expect(effect(command).areas.length).toBeGreaterThan(0);
		},
	);

	it("places an extraction where the command names it", () => {
		expect(effect("7z x a.7z -oout").areas).toEqual(["out"]);
	});

	it("does not resolve an operand that is an expansion", () => {
		expect(effect("gzip $F").uncertain).toBe(true);
	});

	it("reads the program behind an input runner as a writer", () => {
		expect(changes("ls | xargs gzip")).toBe(true);
	});

	it.each([
		"gzip -c f",
		"gzip -dc f.gz",
		"gzip -d -c f.gz",
		"gzip --stdout f",
		"gzip -l f.gz",
		"gzip -t f.gz",
		"gunzip -c f.gz",
		"xz -l f.xz",
		"xz -dc f.xz",
		"zstd -l f.zst",
		"zstd -c f",
		"zstd -dc f.zst",
		"bzip2 -dc f.bz2",
		"gzip --help",
		"zip -sf x.zip",
		"zip -h",
		"less f",
		"xxd f",
		"xxd -c 8 f",
		"shuf a",
		"split --help",
		"csplit --help",
		"7z l x.7z",
		"7z t x.7z",
		"ar t x.a",
		"ar p x.a y",
		"strip --help",
		"script --version",
		"openssl version",
		"openssl dgst -sha256 f",
		"ditto",
		"cpio --help",
		"cpio -o",
		"find . | cpio -ov",
	])("%s stays a read", (command) => {
		expect(changes(command)).toBe(false);
	});

	it("does not change what an unknown program is", () => {
		expect(changes("someprogram f g")).toBe(false);
	});
});

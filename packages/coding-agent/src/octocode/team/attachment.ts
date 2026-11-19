import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { isWithin, resolvePath } from "@octocodeai/octocode-common/paths";
import { secretProblem } from "@octocodeai/octocode-common/sanitize";
import { OCTOCODE_DIR } from "../shared/home.ts";

/** The most bytes of one attached file: the text travels inside the message, so it stays small. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024;

/** Names that hold credentials whatever their content looks like. */
const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|keystore))$/i;

/** Folders that never leave a worktree: repository internals and Octocode's own state. */
const PRIVATE_FOLDER = new Set([".git", OCTOCODE_DIR]);

function refusal(reason: string): Error {
	return new Error(`Not attached: ${reason} Nothing was sent.`);
}

/**
 * The attachment block for the file at `file` (relative to `cwd`, the sender's worktree), to append to a message. The
 * block names the file, its byte count and its SHA-256, then carries the text; the recipient writes it with its file
 * tool and compares the hash. Throws, with nothing sent, for a file that is missing, not a regular text file, over
 * `MAX_ATTACHMENT_BYTES`, outside `cwd` (symlinks resolved), in a private folder, named like a credential file, or
 * whose text looks like it holds a credential.
 */
export async function attachmentText(cwd: string, file: string): Promise<string> {
	const root = await fs.realpath(cwd);
	const wanted = resolvePath(file, root);
	let real: string;
	try {
		real = await fs.realpath(wanted);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw refusal(`${file} does not exist in your worktree.`);
		throw error;
	}
	if (!isWithin(real, root)) throw refusal(`${file} is outside your worktree; only files inside it can be sent.`);
	const parts = path.relative(root, real).split(path.sep);
	if (parts.some((part) => PRIVATE_FOLDER.has(part)) || SECRET_NAME.test(path.basename(real)))
		throw refusal(`${file} is private (repository internals, Octocode state or a credential file).`);
	const info = await fs.stat(real);
	if (!info.isFile()) throw refusal(`${file} is not a regular file.`);
	if (info.size > MAX_ATTACHMENT_BYTES)
		throw refusal(`${file} is ${info.size} bytes; the limit is ${MAX_ATTACHMENT_BYTES}. Send a smaller excerpt.`);
	const bytes = await fs.readFile(real);
	if (bytes.includes(0)) throw refusal(`${file} is binary; only text files can be sent.`);
	const text = bytes.toString("utf8");
	if (Buffer.from(text, "utf8").compare(bytes) !== 0) throw refusal(`${file} is not valid UTF-8 text.`);
	const problem = secretProblem(text);
	if (problem) throw refusal(`${file}: ${problem}.`);
	const hash = sha256(bytes);
	const name = path.relative(root, real).split(path.sep).join("/");
	return [
		`<attachment path="${name}" bytes="${bytes.length}" sha256="${hash}">`,
		text,
		`</attachment>`,
		`Write the attachment with your file tool, then check its SHA-256 equals the one above.`,
	].join("\n");
}

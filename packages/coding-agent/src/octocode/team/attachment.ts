import { promises as fs } from "node:fs";
import path from "node:path";
import { renderPrompt } from "../../core/prompt-template.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { isWithin, resolvePath } from "@octocodeai/octocode-common/paths";
import { secretProblem } from "@octocodeai/octocode-common/sanitize";
import { OCTOCODE_DIR } from "../shared/home.ts";
import { saveNamedContent } from "../shared/spill.ts";

/**
 * The most bytes of one attached file. The message carries only a reference: the sender saves the bytes and the
 * recipient's file tool writes them, so no model copies the text. The cap bounds what one reference writes.
 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024;

/** Names that hold credentials whatever their content looks like. */
const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|keystore))$/i;

/** Folders that never leave a worktree: repository internals and Octocode's own state. */
const PRIVATE_FOLDER = new Set([".git", OCTOCODE_DIR]);

/** The saved copy of an attachment: named by its content's SHA-256, so a reader checks the file against its own name. */
export const attachmentFileName = (hash: string): string => `attachment-${hash}.txt`;

/** One `<attachment …/>` reference a message carries. */
export interface AttachmentReference {
	/** The file's path in the sender's worktree (`/`-separated), the name a recipient would usually write it under. */
	path: string;
	bytes: number;
	sha256: string;
	/** Where the sender saved the bytes (`attachmentFileName`). */
	saved: string;
}

const escapeAttribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unescapeAttribute = (value: string): string =>
	value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const REFERENCE = /<attachment path="([^"]*)" bytes="(\d+)" sha256="([0-9a-f]{64})" saved="([^"]+)"\/>/g;

/** Every attachment reference in a message's text, in order. The text is untrusted: the reader checks each saved file. */
export function attachmentReferences(text: string): AttachmentReference[] {
	return [...text.matchAll(REFERENCE)].map(([, name, bytes, hash, saved]) => ({
		path: unescapeAttribute(name),
		bytes: Number(bytes),
		sha256: hash,
		saved: unescapeAttribute(saved),
	}));
}

/**
 * Why `bytes` (of `shown`) cannot travel as an attachment, or undefined when they can: binary, not UTF-8, or text that
 * looks like it holds a credential. The sender checks this before saving and the recipient's file tool again before
 * writing, so a saved file put there by other means is held to the same rule.
 */
export function attachmentTextProblem(shown: string, bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return `${shown} is binary; only text files can be sent.`;
	const text = bytes.toString("utf8");
	if (Buffer.from(text, "utf8").compare(bytes) !== 0) return `${shown} is not valid UTF-8 text.`;
	const problem = secretProblem(text);
	return problem ? `${shown}: ${problem}.` : undefined;
}

function refusal(reason: string): Error {
	return new Error(`Not attached: ${reason} Nothing was sent.`);
}

/**
 * The attachment reference for the file at `file` (relative to `cwd`, the sender's worktree), to put in a message. The
 * bytes are saved content-addressed in this session's output folder (`attachmentFileName`, as spilled output is); the
 * reference names the file, its byte count, its SHA-256 and that copy, and the recipient writes it with its file tool's
 * `fromAttachment`, so the text passes through no model. Throws, with nothing sent, for a file that is missing, not a
 * regular text file, over `MAX_ATTACHMENT_BYTES`, outside `cwd` (symlinks resolved), in a private folder, named like a
 * credential file, whose text looks like it holds a credential, or that could not be saved.
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
	const problem = attachmentTextProblem(file, bytes);
	if (problem) throw refusal(problem);
	const hash = sha256(bytes);
	const saved = saveNamedContent(bytes, attachmentFileName(hash));
	if (!saved) throw refusal(`${file} could not be saved for the recipient.`);
	const name = path.relative(root, real).split(path.sep).join("/");
	return [
		`<attachment path="${escapeAttribute(name)}" bytes="${bytes.length}" sha256="${hash}" saved="${escapeAttribute(saved)}"/>`,
		renderPrompt("tools/file/from-attachment.md", { sha256: hash }),
	].join("\n");
}

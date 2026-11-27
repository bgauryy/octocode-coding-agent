import type { CallOptions, OperationClientConfig } from "./config.ts";
import { OperationError } from "./errors.ts";
import { asArray, asNumber, asRecord, asString, optString, perform, requireId, requireNonEmpty } from "./http.ts";
import { appendFile, type UploadFile } from "./upload.ts";

/** Upload cap enforced client-side (OpenAI documents 512 MB per file). */
export const MAX_FILE_UPLOAD_BYTES = 512 * 1024 * 1024;

export interface FileObject {
	id: string;
	bytes: number;
	createdAt: number;
	filename: string;
	purpose: string;
	status?: string;
}

export interface FileList {
	files: FileObject[];
	hasMore: boolean;
}

function parseFile(raw: unknown, op: string): FileObject {
	const r = asRecord(raw, op, "file");
	return {
		id: asString(r.id, op, "id"),
		bytes: asNumber(r.bytes, op, "bytes"),
		createdAt: asNumber(r.created_at, op, "created_at"),
		filename: asString(r.filename, op, "filename"),
		purpose: asString(r.purpose, op, "purpose"),
		status: optString(r.status),
	};
}

/** `POST /files` (multipart). */
export async function uploadFile(
	config: OperationClientConfig,
	request: { file: UploadFile; purpose: string },
	options?: CallOptions,
): Promise<FileObject> {
	const op = "files.upload";
	requireNonEmpty(request.purpose, op, "purpose");
	const form = new FormData();
	appendFile(form, "file", request.file, MAX_FILE_UPLOAD_BYTES, op);
	form.append("purpose", request.purpose);
	const { body } = await perform(config, { operation: op, method: "POST", path: "files", form }, "json", options);
	return parseFile(body, op);
}

/** `GET /files` with optional purpose filter and cursor paging. */
export async function listFiles(
	config: OperationClientConfig,
	query: { purpose?: string; limit?: number; after?: string; order?: "asc" | "desc" } = {},
	options?: CallOptions,
): Promise<FileList> {
	const op = "files.list";
	const { body } = await perform(config, { operation: op, method: "GET", path: "files", query }, "json", options);
	const root = asRecord(body, op, "response");
	return { files: asArray(root.data, op, "data").map((f) => parseFile(f, op)), hasMore: root.has_more === true };
}

/** `GET /files/{id}`. */
export async function getFile(config: OperationClientConfig, id: string, options?: CallOptions): Promise<FileObject> {
	const op = "files.get";
	const { body } = await perform(
		config,
		{ operation: op, method: "GET", path: `files/${requireId(id, op)}` },
		"json",
		options,
	);
	return parseFile(body, op);
}

/** `DELETE /files/{id}`; fails unless the server confirms deletion. */
export async function deleteFile(
	config: OperationClientConfig,
	id: string,
	options?: CallOptions,
): Promise<{ id: string }> {
	const op = "files.delete";
	const { body } = await perform(
		config,
		{ operation: op, method: "DELETE", path: `files/${requireId(id, op)}` },
		"json",
		options,
	);
	const root = asRecord(body, op, "response");
	if (root.deleted !== true) throw new OperationError("malformed_response", op, "server did not confirm deletion");
	return { id: asString(root.id, op, "id") };
}

/** `GET /files/{id}/content`; bytes bounded by maxResponseBytes. */
export async function downloadFile(
	config: OperationClientConfig,
	id: string,
	options?: CallOptions,
): Promise<Uint8Array> {
	const op = "files.content";
	const { body } = await perform(
		config,
		{ operation: op, method: "GET", path: `files/${requireId(id, op)}/content` },
		"bytes",
		options,
	);
	return body;
}

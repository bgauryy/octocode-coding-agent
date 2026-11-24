import { OperationError } from "./errors.ts";

/** In-memory file payload for multipart uploads. */
export interface UploadFile {
	data: Uint8Array | Blob;
	filename: string;
	contentType?: string;
}

export function uploadSize(file: UploadFile): number {
	return file.data instanceof Blob ? file.data.size : file.data.byteLength;
}

/** Appends the file part after validating name and size. */
export function appendFile(form: FormData, field: string, file: UploadFile, maxBytes: number, operation: string): void {
	if (!file.filename || /[\r\n"\\/]/.test(file.filename)) {
		throw new OperationError("invalid_input", operation, "filename is empty or contains forbidden characters");
	}
	const size = uploadSize(file);
	if (size === 0) throw new OperationError("invalid_input", operation, "file is empty");
	if (size > maxBytes) throw new OperationError("invalid_input", operation, `file exceeds ${maxBytes} bytes`);
	const blob =
		file.data instanceof Blob
			? file.data
			: new Blob([file.data as Uint8Array<ArrayBuffer>], file.contentType ? { type: file.contentType } : undefined);
	form.append(field, blob, file.filename);
}

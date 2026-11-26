import { isImageLine } from "../terminal-image.ts";
import { trimTrailingBlanks } from "./trailing-blanks.ts";

/** Erase the cursor's line, then its text: a row of blanks costs no bytes, and an image row goes out whole. */
export function eraseAndWriteRow(line: string, isImage = isImageLine(line)): string {
	return `\x1b[2K${isImage ? line : trimTrailingBlanks(line)}`;
}

/*
 * Escape-sequence grammar: the scanner in @octocodeai/octocode-tui (ECMA-48). This file keeps the stripAnsi
 * API and the streaming split; it was derived from:
 * - ansi-regex (https://github.com/chalk/ansi-regex)
 * - strip-ansi (https://github.com/chalk/strip-ansi)
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { incompleteAnsiStart, stripTerminalSequences } from "@octocodeai/octocode-tui";

// Longest unfinished sequence held back while streaming. Longer ones are processed as-is.
const MAX_PENDING_ANSI_LENGTH = 256;

/**
 * Split streamed text into a part that is safe to pass to stripAnsi now and a trailing
 * unfinished escape sequence that should be prepended to the next chunk.
 */
export function splitIncompleteAnsiSuffix(value: string): { complete: string; pending: string } {
	const splitAt = incompleteAnsiStart(value, Math.max(0, value.length - MAX_PENDING_ANSI_LENGTH));
	if (splitAt === -1) {
		return { complete: value, pending: "" };
	}
	return { complete: value.slice(0, splitAt), pending: value.slice(splitAt) };
}

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}
	return stripTerminalSequences(value);
}

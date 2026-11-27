import { renderPrompt } from "../../core/prompt-template.ts";
import { escapeHeaderLike, makeSource, renderSourceHeader } from "../events/source.ts";
import { fenceUntrusted, headerText } from "../shared/fence.ts";
import { capContext } from "./runner.ts";

/**
 * The text a hook's output becomes for the model: the hook source's header, then the output inside the shared untrusted
 * fence, so what a hook command printed reads as data and cannot pass as a header, a second message or the user.
 */
export function hookContext(source: string, text: string): string {
	const header = renderSourceHeader(makeSource("hook", headerText(source, 64), "in-process", "proven"));
	return `${header}\n${fenceUntrusted(renderPrompt("hooks/context.md", { source: headerText(source, 64) }), escapeHeaderLike(capContext(text), { fences: false }))}`;
}

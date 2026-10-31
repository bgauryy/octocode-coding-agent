import type { ApplicationMessage } from "@octocodeai/octocode-contracts";
import { Spacer } from "@octocodeai/octocode-tui";
import { parseSkillBlock } from "../../../core/agent-session.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { sanitizeTerminalText } from "../../../octocode/shared/sanitize.ts";
import { contentText, FullContentReader } from "../components/application-content.ts";
import { SkillInvocationMessageComponent } from "../components/skill-invocation-message.ts";
import { UserMessageComponent } from "../components/user-message.ts";
import type { InteractiveModeHost } from "./host.ts";

type Host = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "editor"
	| "getMarkdownThemeWithSettings"
	| "getMarkdownTransformers"
	| "outputPad"
	| "session"
	| "settingsManager"
	| "toolOutputExpanded"
	| "ui"
>;

/** Live delivery and history use the same user block styles, including skill invocation folding. */
export function addApplicationUserMessage(
	host: Host,
	message: ApplicationMessage,
	options?: { populateHistory?: boolean },
): void {
	const port = getApplicationPort(host.session);
	const readAsset = (id: string) => port.readAsset(id);
	message = new FullContentReader().message(message, readAsset);
	const text =
		message.content
			?.filter((block) => block.type === "text")
			.map((block) => contentText(block, readAsset))
			.join("") ?? message.text;
	if (!message.content?.length && !text) return;
	if (host.chatContainer.children.length) host.chatContainer.addChild(new Spacer(1));
	const skill = message.content?.some((block) => block.type !== "text")
		? undefined
		: parseSkillBlock(sanitizeTerminalText(text));
	if (skill) {
		const component = new SkillInvocationMessageComponent(skill, host.getMarkdownThemeWithSettings(), host.outputPad);
		component.setExpanded(host.toolOutputExpanded);
		host.chatContainer.addChild(component);
		if (skill.userMessage) {
			host.chatContainer.addChild(new Spacer(1));
			host.chatContainer.addChild(
				new UserMessageComponent(
					skill.userMessage,
					host.getMarkdownThemeWithSettings(),
					host.outputPad,
					host.getMarkdownTransformers(),
				),
			);
		}
	} else {
		host.chatContainer.addChild(
			new UserMessageComponent(
				message,
				host.getMarkdownThemeWithSettings(),
				host.outputPad,
				host.getMarkdownTransformers(),
				{
					readAsset,
					showImages: host.settingsManager.getShowImages(),
					imageWidthCells: host.settingsManager.getImageWidthCells(),
					requestRender: () => host.ui.requestRender(),
				},
			),
		);
	}
	if (options?.populateHistory && text) host.editor.addToHistory?.(text);
}

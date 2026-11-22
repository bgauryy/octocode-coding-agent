import type { ApplicationMessage } from "@octocodeai/octocode-contracts";
import { Spacer } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { parseSkillBlock } from "../../../core/agent-session.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
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
	| "uiStore"
	| "ui"
>;

/** Live delivery and history use the same user block styles, including skill invocation folding. */
export function addApplicationUserMessage(
	host: Host,
	received: ApplicationMessage,
	options?: { populateHistory?: boolean },
): void {
	const port = getApplicationPort(host.session);
	const readAsset = (id: string) => port.readAsset(id);
	const message = new FullContentReader().message(received, readAsset);
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
	const addUser = (component: UserMessageComponent) => {
		component.setExpanded(host.uiStore.getState().view.toolsExpanded);
		host.chatContainer.addChild(component);
	};
	if (skill) {
		const component = new SkillInvocationMessageComponent(
			skill,
			host.getMarkdownThemeWithSettings(),
			host.outputPad,
			host.ui,
		);
		component.setExpanded(host.uiStore.getState().view.toolsExpanded);
		host.chatContainer.addChild(component);
		if (skill.userMessage) {
			host.chatContainer.addChild(new Spacer(1));
			addUser(
				new UserMessageComponent(
					skill.userMessage,
					host.getMarkdownThemeWithSettings(),
					host.outputPad,
					host.getMarkdownTransformers(),
				),
			);
		}
	} else {
		addUser(
			new UserMessageComponent(
				message,
				host.getMarkdownThemeWithSettings(),
				host.outputPad,
				host.getMarkdownTransformers(),
				{
					readAsset,
					keepScrollbackOnCollapse: () => host.ui.keepScrollbackOnCollapse?.(),
					showImages: host.settingsManager.getShowImages(),
					imageWidthCells: host.settingsManager.getImageWidthCells(),
					requestRender: () => host.ui.requestRender(),
				},
			),
		);
	}
	if (options?.populateHistory && text) host.editor.addToHistory?.(text);
}

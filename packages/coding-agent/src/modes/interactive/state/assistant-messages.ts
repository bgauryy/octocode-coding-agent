import { Container } from "@octocodeai/octocode-tui";
import { AssistantMessageComponent } from "../components/assistant-message.ts";

/** Visits every assistant message in the transcript, including those nested in groups. */
export function forEachAssistantMessage(
	container: Container,
	visit: (message: AssistantMessageComponent) => void,
): void {
	for (const child of container.children) {
		if (child instanceof AssistantMessageComponent) visit(child);
		else if (child instanceof Container) forEachAssistantMessage(child, visit);
	}
}

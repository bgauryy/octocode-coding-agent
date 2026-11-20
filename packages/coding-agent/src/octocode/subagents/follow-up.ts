import { USER_SENDER } from "../shared/messages.ts";
import { messageText } from "../team/routing.ts";
import type { ResumeRequest } from "../team/session/send.ts";

/**
 * The follow-up a message resumes a finished child with: the stored message framed as delivered mail (`messageText`:
 * its id, its original sender, and the fence for anyone but the user), or, without a stored row, the bare text.
 * `from` is who asks for the resume, `request.message.from` who wrote it, `parentId` the child's parent.
 */
export function followUpText(
	text: string,
	from: string,
	parentId: string | undefined,
	request: ResumeRequest | undefined,
): string {
	if (!request) return `Follow-up from ${from === USER_SENDER ? "the user" : "your coordinator"}:\n${text}`;
	return messageText(request.message, {
		parentId,
		// The user's own message, created in this process for this resume; a relayed or forwarded one never is.
		fromUser: from === USER_SENDER && request.message.from === USER_SENDER && !request.message.forwardedBy,
	});
}

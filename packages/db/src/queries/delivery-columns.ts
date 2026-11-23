/** The columns `toMessage` reads from a delivery joined with its message (`m`) and the sender's agent row (`s`). */
export const DELIVERED_COLUMNS =
	"m.id, m.sender, m.body, m.created_at, m.reply_required, m.reply_to, d.wake, d.proof, d.forwarded_by, d.note, s.role AS sender_role, s.task AS sender_goal";

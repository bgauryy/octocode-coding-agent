import type { Member } from "@octocodeai/octocode-contracts/team";

/** A hosted vendor turn reads mail cooperatively and cannot receive native interrupts. */
export const runnerMember = (member: Member): boolean => member.mailbox === "pull";

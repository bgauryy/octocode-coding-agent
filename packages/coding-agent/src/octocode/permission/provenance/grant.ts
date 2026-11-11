import type { AskReason } from "../mode.ts";
import type { PermissionRequest, SourceGrant } from "../request.ts";

/** The reason the grant answers, which it is listed under (`/permissions grants`). */
const grantReason = (grant: SourceGrant): AskReason => grant.reason ?? "provenance";

export const sourceGrant = (agent: string): SourceGrant => ({ key: agent, label: `text from agent ${agent}` });

/** The key a session grant is held under, beside the other grants. */
export const sourceGrantKey = (grant: SourceGrant): string => `${grantReason(grant)}\0${grant.key}`;

/** How `Permission.grants()` lists it. */
const sourceGrantListing = (grant: SourceGrant): string => `${grantReason(grant)}: ${grant.label}`;

/** Whether the user gave `grant` for this session. */
export const isGranted = (permission: { grants(): readonly string[] }, grant: SourceGrant): boolean =>
	permission.grants().includes(sourceGrantListing(grant));

/** The `allowed` argument of `Provenance.check` and `sent`: a subagent whose text the user allowed for this session is no hit. */
export const grantedSource =
	(permission: { grants(): readonly string[] }) =>
	(agent: string): boolean =>
		isGranted(permission, sourceGrant(agent));

/** The source grant `request` names, when the reason it answers is the request's only forcing reason. */
export const grantableSource = (request: PermissionRequest, forcing: readonly string[]): SourceGrant | undefined =>
	request.sourceGrant && forcing.length === 1 && forcing[0] === grantReason(request.sourceGrant)
		? request.sourceGrant
		: undefined;

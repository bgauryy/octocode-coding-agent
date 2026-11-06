import type { PermissionRequest, SourceGrant } from "../request.ts";

/** The `action` the grant is listed under (`/permissions grants`). */
const GRANT_ACTION = "provenance";

export const sourceGrant = (agent: string): SourceGrant => ({ key: agent, label: `text from agent ${agent}` });

/** The key a session grant is held under, beside the other grants. */
export const sourceGrantKey = (grant: SourceGrant): string => `${GRANT_ACTION}\0${grant.key}`;

/** How `Permission.grants()` lists it. */
const sourceGrantListing = (grant: SourceGrant): string => `${GRANT_ACTION}: ${grant.label}`;

/** The `allowed` argument of `Provenance.check` and `sent`: a subagent whose text the user allowed for this session is no hit. */
export const grantedSource =
	(permission: { grants(): readonly string[] }) =>
	(agent: string): boolean =>
		permission.grants().includes(sourceGrantListing(sourceGrant(agent)));

/** Whether `request`'s only forcing reason is its provenance hit and it names a source the user may allow. */
export const grantableSource = (request: PermissionRequest, forcing: readonly string[]): SourceGrant | undefined =>
	forcing.length === 1 && forcing[0] === "provenance" ? request.sourceGrant : undefined;

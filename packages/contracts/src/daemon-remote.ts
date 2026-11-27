import { Type, type Static } from "typebox";

/** How a remote link reaches the daemon: a port forward the user runs (`ssh`), or a content-blind `relay` the daemon dials. */
export const RemoteTransportSchema = Type.Union([Type.Literal("ssh"), Type.Literal("relay")]);
/** What a remote link may do: `view` reads everything and sends nothing; `control` is the page's full surface. */
export const RemoteAccessSchema = Type.Union([Type.Literal("view"), Type.Literal("control")]);

/** `POST /api/admin/remote`: publish one link. The relay address comes from settings; a request may name it. */
export const RemotePublishSchema = Type.Object(
	{
		transport: RemoteTransportSchema,
		access: RemoteAccessSchema,
		relayUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
	},
	{ additionalProperties: false },
);

/** One published link. The URL carries the capability (a token or a key) in its fragment, never in a server-visible part. */
export const RemoteLinkSchema = Type.Object(
	{
		transport: RemoteTransportSchema,
		access: RemoteAccessSchema,
		url: Type.String({ minLength: 1, maxLength: 2048 }),
		issuedAt: Type.Number(),
		/** `ssh` only: the port forward to run on the other device before opening the link. */
		forward: Type.Optional(Type.String({ maxLength: 512 })),
	},
	{ additionalProperties: false },
);

/**
 * One published link as `GET /api/admin/remote` lists it: no URL, token or key, only a short fingerprint of the
 * capability to tell links apart. The full link is shown once, when it is published.
 */
export const RemoteLinkStatusSchema = Type.Object(
	{
		transport: RemoteTransportSchema,
		access: RemoteAccessSchema,
		issuedAt: Type.Number(),
		fingerprint: Type.String({ pattern: "^[0-9a-f]{8}$" }),
	},
	{ additionalProperties: false },
);

/** `GET /api/admin/remote`: every link published since the daemon started, and the relay connection when one is dialed. */
export const RemoteStatusSchema = Type.Object(
	{
		links: Type.Array(RemoteLinkStatusSchema, { maxItems: 50 }),
		relay: Type.Optional(
			Type.Object(
				{
					url: Type.String({ maxLength: 512 }),
					state: Type.Union([Type.Literal("connecting"), Type.Literal("connected"), Type.Literal("closed")]),
					/** Peers the relay has joined to this daemon right now. */
					peers: Type.Integer({ minimum: 0 }),
					error: Type.Optional(Type.String({ maxLength: 300 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type RemoteTransport = Static<typeof RemoteTransportSchema>;
export type RemoteAccess = Static<typeof RemoteAccessSchema>;
export type RemotePublish = Static<typeof RemotePublishSchema>;
export type RemoteLink = Static<typeof RemoteLinkSchema>;
export type RemoteLinkStatus = Static<typeof RemoteLinkStatusSchema>;
export type RemoteStatus = Static<typeof RemoteStatusSchema>;

---
status: Implemented
confidence: high for the transport and the verb; medium for the merge prompt wording until the live eval runs
question: Can two Octocode processes, and a linked worktree and its main checkout, talk over ACP, under one protocol the model sees?
---

# RFC: one agent-to-agent protocol

Date: 2026-11-04. Extends [shared communication contracts](RFC_COMMUNICATION_PROTOCOL.md), which keeps each transport's delivery contract; this RFC adds one model-facing verb over them and changes no wire contract except the additions under [What changes on the wire](#what-changes-on-the-wire). [ACP exposure](RFC_ACP_EXPOSURE.md) is unchanged.

## Answer

**ACP cannot reach a running session; the local session API can, so it carries process-to-process messages.** The model does not see that choice. It has one verb, `agent` type `message`, and `to` is a name. A worktree's finished work goes `to` `coordinator`, the session in the main checkout, which owns the merge and asks its own user first.

## Can ACP do this?

No, by its own definition:

- ACP v1 has one transport, and in it [the client launches the agent as a subprocess](https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/docs/protocol/v1/transports.mdx) and owns its stdin and stdout. Remote transport is still an RFD.
- A session is client-driven: [`initialize`, `session/new`, then `session/prompt`](https://github.com/agentclientprotocol/agent-client-protocol/blob/734309dc6ff8f5a3b93adca62826dd63cff85a26/docs/protocol/v1/overview.mdx). An agent cannot start a conversation with its client, and there is no address for a third party.
- A terminal session has no ACP endpoint, and its stdio belongs to the person. `--mode acp` would start a *new* worker, which is a different session. So ACP can spawn a peer, not reach one.

| Transport | Reaches a running session? | Identity | Delivery fact | Verdict |
| --- | --- | --- | --- | --- |
| ACP | No: launches a process | Client-assigned session | Prompt stop reason | Keep for editors and outside agents |
| Session API (`message.send`, Unix socket) | Yes, every top-level session, by default | Process name, instance id | Receipt, then run settlement; `execution` on failure | **Carries process-to-process** |
| Team database | Only members that joined: `agents.tell` to an unjoined session answers "No live agent" ([audit](../.octocode/audit-2026-11-04/acp-audit.md)); repository-scoped | Agent id | Durable, acknowledged in model context | Keep for parent, child and sibling |
| [A2A](https://github.com/a2aproject/A2A/blob/4735f4876449c6f381825d8a841b31b16c6ad0c4/docs/specification.md) | Only with a new HTTP server, Agent Cards and authentication it requires | Agent Card | Task states | Not for same-user local sessions; stays an optional remote adapter |

## What exists today

| Path | Verb | Id the model used | Failure it saw |
| --- | --- | --- | --- |
| Child to parent | `agent` `message`, `to: parent` | `parent` | Dead letter; a foreground parent reads it with the report |
| Parent to child | `agent` `message` | id or role | "No live agent"; a parked child resumes |
| Sibling | `agent` `message` | id, or relayed through the parent | Relay refused |
| **Process to process** | **bash `octocode-api send`, or `external` connect then prompt** | **`--to` instance id or name** | **Exit code and JSON; busy peers refused** |
| **Worktree to main checkout** | **none** | **none** | **none** |
| Octocode to an outside agent | `agent` `external` connect, prompt | connection id | `execution`, partial reply |

The needless differences were the two bold rows: another Octocode took a shell command or a two-step connection, and a worktree had nothing.

## Decision

1. **One verb.** `agent` type `message`, `to` a name, also reaches another Octocode process by its process name (`octocode-main-c0ea9f3e`). Delivery is chosen by destination. Children have no such route: a restricted child must not be able to ask an unrestricted session to act, and its schema does not change.
2. **A process message does not block.** The sender gets a receipt and ends its turn; the answer arrives as another message from the receiver's name, starting a turn. This is the same as team mail, and it avoids two sessions waiting on each other.
3. **Every message says who it is from, by name.** The receiver's header, footer and reply hint use the process name. The external marking and fence stay as built: a message from another process is a request, never authority.
4. **`coordinate list` shows other sessions** with name, working directory, busy state, and which one is this repository's coordinator.
5. **A session knows its own name** from one line in the `environment` section, a volatile section after the cached prefix. `/new`, `/resume` and `/fork` start a new conversation and so a new process name and instance id; the line updates, and an old name fails with what is running.
6. **Outside agents keep `agent` type `external`.** An ACP prompt is a blocking turn on a connection the caller opened, so it does not fit "send to a name", and a second way to reach it would be an alias.

## Receiving an external message is a permission class

The owner decided this on 2026-11-04. `message.external` is one more class in the [mode table](../packages/coding-agent/src/octocode/permission/mode.ts), so it needs no parallel check:

| Mode | A message arrives |
| --- | --- |
| `full`, the default | Accepted, its turn runs like any other, recorded in the audit |
| `workspace`, `manual` | The user sees who sent it and what it asks: allow once; allow this process for this session; allow all external messages for this session; deny |
| Plan, over any mode | Asks as `manual` does; the turn it starts is held to the plan constraint |
| No one to ask | Refused, as every ask is |

- The API stays on by default; `sessionApi: false` and `/api off` turn it off.
- A process grant needs a caller that names a running instance. Another caller gets once, all or deny. Session grants do not outlive the session, so no wider scope exists, and a process name would not outlive its process anyway.
- While the user decides, a sender that does not wait gets `queued: "waiting-for-user"` at once. A sender using `agent` `message` is told the outcome later if refused. A sender using `--wait` waits within its own `--timeout`; no deadline was added.
- A denial or no UI gives the sender a refusal naming the session and what its user can do. Nothing is silent.
- Accepting a message widens nothing: tools in that turn follow the session's mode, and `manual` still asks.
- `/permissions` lists the grants, `/permissions grants clear messages` removes them, and the audit names the process for each decision.

Nothing verifies who sends: any program running as this user can claim a process name, and that is the boundary this class works within.

## The worktree merge workflow

```text
linked worktree session                 session in the main checkout
  finish, commit, run checks
  agent message to: coordinator ──────▶ external message (a request)
    0 or several: told, nothing sent    review the request
                                        agent coordinate merge branch: X
                                          linked worktree's branch? clean?
                                          a reservation? a conflict?
                                          ask the user (every mode)
  ◀────────────────── agent message to: <sender name>, with the result
```

- **Coordinator:** the one session whose working directory is in the main checkout, per `git worktree list`. It need not be idle. A session in a linked worktree cannot be one, and `to: coordinator` from the main checkout is refused.
- **No coordinator or several:** the tool sends nothing and says so, naming the sessions when there are several. Then the model tells the user; the worktree and its branch stay as they are. It never picks silently and never waits. With several, the user's choice goes in `to` by name.
- **A worktree session never merges into the main checkout.** The text says so; `coordinate merge` refuses outside the main checkout. Bash `git -C <main> merge` is not stopped, so this is a rule, not a boundary.
- **The coordinator owns the merge.** `coordinate merge` with `branch` takes only a linked worktree's branch. It refuses uncommitted work, a merge in progress, a path another agent holds and a conflict, each with the reason to send back. It leaves the worktree and the branch in place, and it reuses the merge and reservation code of `/agents merge`.

### Merging needs authorization

An external message grants none, and "commit or push only when the user asks" still holds. So **`worktree.merge` asks in every mode, `full` included, like `browser.cookies`, and is refused where no one can be asked.** A user's prior request counts in two forms: the answer "Allow all worktree merges for this session" and typing `/worktree merge <branch>`. A request in chat still gets one confirmation, because the tool cannot tell "merge it" from "don't merge it".

**The limit:** in `full`, a turn may run tools unasked, including `git merge` through `bash`, and an external message can start such a turn. The class guards the tool; only the prompt rule and the fence guard the shell. Accepting a message is not approving a merge, and a stricter guard would be a new owner decision.

## Security

- **Reach:** owner-only socket, as the [session API guide](../packages/coding-agent/docs/session-api.md#who-can-reach-a-session) describes. No listener was added, and over the socket the caller stays unverified.
- **Forgery:** header and footer are built by the receiver from quoted claims, and the fence marker is random. The tests carry forged fences and forged approvals.
- **Dialogs:** an external message reaches the model, never a pending dialog.
- **Prompt injection:** a message can ask a model to send more messages. There is no rate gate, by the owner's rule on rigid gates; the footer says not to answer an acknowledgment, and each message is audited.

## What the model sees

`policy/communication.md`, for the main session only, conditional on the tools it names. Children get no new text: they already message their parent and teammates and cannot reach another process. Tool mechanics stay in the `to`, `branch` and action descriptions. The `to` field names both new addresses; `branch` is one field in the main session's schema.

## What changes on the wire

Additive: `message.send` takes `replyRequired`; a non-waiting send may answer `queued: "waiting-for-user"` with a `key` to ask for the outcome; a retry with the same key after a refusal repeats that refusal rather than asking again; `details.external.replyTo` is now the process name, not the instance id. The `to` selector stays the exact process name, instance id or session id.

## Rollout and rollback

It ships on by default with no setting, since `sessionApi` already covers it. Rollback by behaviour:

- Delete the process route from `tools/messages.ts` and the model falls back to team addressing, whose refusal is clear.
- Set the `message.external` row to `allow` everywhere to restore unconditional delivery.
- Set the `worktree.merge` row's `full` cell to `allow` if the owner wants `full` to merge unasked: one word.

## Validation

Real processes on the scripted model, in isolated homes, in `test/octocode/e2e-a2a.test.ts` and `e2e-a2a-permission.test.ts`:

- Two sessions, both directions, by name.
- A real linked worktree: approve, decline, conflict, no coordinator, two coordinators, a held path.
- Each dialog choice's scope, one process's grant not admitting another, denial and no-UI refusals, a forged approval, `/permissions` listing and revoking.
- `agent-context` captures show the section for main and its absence in each child. `scripts/agent-eval/understanding.json` holds the behaviour questions; the live run belongs to the owner.

## Open questions

- Whether `full` should merge without asking. This RFC keeps the ask; the row above makes either answer one word.
- Whether a chat request should skip the merge confirmation, once a tool can tell a request from a mention.
- A stable per-process name across `/new` ([audit decision 3](../.octocode/audit-2026-11-04/acp-audit.md)). Today an old name fails with what is running.

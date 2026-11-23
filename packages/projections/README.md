# @octocodeai/octocode-projections

Portable interpretation of the application protocol that every interface shares: the web page today, the terminal and other clients later. It folds application frames from [contracts](../contracts/README.md) into a bounded read model. It depends only on contracts and runs anywhere JavaScript runs.

| Module                   | Holds                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `application-stream`     | `ApplicationStream`: validates and orders frames, applies snapshots and events, reconciles receipts, asks for a resync after a gap, keeps a bounded tool window                                                                                  |
| `application-projection` | `ApplicationProjection`: stable row identities and authoritative content for live updates, snapshots and history pages                                                                                                                           |
| `activity`               | `activity(facts)`: what a session or agent is doing as its light shows it (tone `working`, `waiting`, `error` or `idle`, the design state that draws it, and the words beside it), the one mapping the footer, session lists and web header read |
| `selectors`              | Derived values interfaces share: whether a message is displayed, and a tool call's state                                                                                                                                                         |

Keep out: Node built-ins, DOM, React, terminal libraries, any other workspace, filesystem, network, clocks, credentials and permission decisions. Interfaces own rendering and transport; the host owns execution and authorization. `yarn run check:boundaries` rejects any import other than contracts, and the build compiles without DOM or Node types.

```sh
yarn workspace @octocodeai/octocode-projections run build
yarn workspace @octocodeai/octocode-projections run test
```

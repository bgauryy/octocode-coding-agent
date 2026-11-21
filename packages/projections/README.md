# @octocodeai/octocode-projections

Portable interpretation of the application protocol that every interface shares: the web page today, the terminal and other clients later. It folds application frames from [contracts](../contracts/README.md) into a bounded read model. It depends only on contracts and runs anywhere JavaScript runs.

| Module               | Holds                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application-stream` | `ApplicationStream`: validates and orders frames, applies snapshots and events, reconciles receipts, asks for a resync after a gap, keeps a bounded tool window |

Keep out: Node built-ins, DOM, React, terminal libraries, any other workspace, filesystem, network, clocks, credentials and permission decisions. Interfaces own rendering and transport; the host owns execution and authorization. `yarn run check:boundaries` rejects any import other than contracts, and the build compiles without DOM or Node types.

```sh
yarn workspace @octocodeai/octocode-projections run build
yarn workspace @octocodeai/octocode-projections run test
```

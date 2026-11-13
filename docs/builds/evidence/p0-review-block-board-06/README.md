# Evidence — P0 Review block before authorization (board 06)

MOCKED loopback evidence only: the Base authoring harness, the user-funded chain double and a disposable loopback PostgreSQL (the
`editor-wallet-batch` profile's harness). The test wallet only answers `wallet_getCapabilities`; nothing is authorized, signed or sent.
None of this is evidence of a public or mainnet execution.

Each image is the Execute tab at 1440×900 right after "Review whole workflow", before anything is authorized:

- `before-*`: main `d3f30a2` (the Review as it was: per-step status list, groups with chain ids, the panel's own buttons, long paragraphs);
- `after-*`: this PR (REVIEW · "You are authorizing", plain lines, Technical details collapsed, ONE primary action in the Editor footer).

Workflows, authored with the Canvas's own command grammar (no Copilot), as in `e2e/editor-wallet-batch.spec.ts`:

- `swap-supply`: `swap 3 USDC to WETH on Base slippage 50 bps` + `supply 0.0013 WETH to Aave on Base` (two steps: the block sits beside
  the cards);
- `swap-supply-borrow`: the same plus `borrow 0.8 USDC on Base` (three steps: the block sits under the cards).

Variants: `en`/`pt` × `light`/`dark`. A Swap → Bridge workflow is not shown: this harness has no Base → Arbitrum One route, so its Review
would only show the "quotes are not active" state.

The capture spec was a local, uncommitted copy of `editor-wallet-batch.spec.ts`'s setup that stops after the Review is shown; the same spec
ran against both builds.

## Swap → Bridge (the owner's scenario)

`swap 2 USDC to WETH on Base slippage 50 bps` + `bridge 0.0003 WETH from Base to Arbitrum One slippage 100 bps`, on the same harness
(captured by a second session from the same production builds). The harness has no batchable Base → Arbitrum One route, so the Review plans
this workflow step by step (the bridge goes through the Universal Router, its own flow) and the step's own flow is unavailable here; the
board 06 block still reads it in plain words (`Levar 0.0003 WETH para Arbitrum One`, "at least 2" wallet requests, the later request quoted
when due), and the footer's per-step action states why it is closed. `before-*` shows the same screen with the earlier panel.

- `*-swap-bridge-{en,pt}-{light,dark}-block.png`: the docked Review only;
- `*-swap-bridge-pt-light-page.png`: the whole Execute screen.

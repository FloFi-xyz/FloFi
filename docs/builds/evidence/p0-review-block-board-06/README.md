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

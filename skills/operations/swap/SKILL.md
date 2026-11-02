# Swap operation (FloFi engineering skill)

- Lifecycle: live estimate (display only) → Simulate (fresh quote and simulation for the owner) → Review (Strategy
  Manifest) → Authorize → owner's wallet → FloFi broadcast or wallet send → observation → reconciliation.
- An estimate is never a Review input. Review re-quotes for the owner.
- Uniswap V3 (EVM): the minimum output is exactly expected × (10 000 − slippage bps) / 10 000. `begin` re-quotes and
  always builds the REVIEWED transaction (route, minimum, deadline where the call carries one). Since
  BUILD-FLOFI-E2E-RELIABILITY-001 it refuses (`QUOTE_CHANGED_REVIEW_REQUIRED`) only a material change: the reviewed route
  quoting below the reviewed minimum or more than half a slippage band above the reviewed expected output, the route gone,
  other assets/amount/slippage/kind, or a Stock Token multiplier change; owner-bound networks also refuse real owner
  changes (nonce, allowance, step, delegation, gas above the reviewed fee ceiling). A request is prepared only with at
  least 15 s of its quote window left.
- Jupiter (Solana): `begin` does not re-quote — the owner signs the exact reviewed v0 message, and a Review past its
  expiry or blockhash validity is refused. Jupiter's `otherAmountThreshold` must be at least the slippage bound; Review
  binds it.
- Latency work must keep these boundaries: cache only immutable, non-financial facts; issue independent reads
  together with ordered failure judgement; never reuse a quote, blockhash, signature or wallet payload.

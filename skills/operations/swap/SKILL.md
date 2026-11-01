# Swap operation (FloFi engineering skill)

- Lifecycle: live estimate (display only) → Simulate (fresh quote and simulation for the owner) → Review (Strategy
  Manifest) → Authorize → owner's wallet → FloFi broadcast or wallet send → observation → reconciliation.
- An estimate is never a Review input. Review re-quotes for the owner.
- Uniswap V3 (EVM): `begin` re-quotes and refuses any economic change (`QUOTE_CHANGED_REVIEW_REQUIRED`); the minimum
  output is exactly expected × (10 000 − slippage bps) / 10 000.
- Jupiter (Solana): `begin` does not re-quote — the owner signs the exact reviewed v0 message, and a Review past its
  expiry or blockhash validity is refused. Jupiter's `otherAmountThreshold` must be at least the slippage bound; Review
  binds it.
- Latency work must keep these boundaries: cache only immutable, non-financial facts; issue independent reads
  together with ordered failure judgement; never reuse a quote, blockhash, signature or wallet payload.

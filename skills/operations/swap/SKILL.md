# Swap operation (FloFi engineering skill)

- Lifecycle: live estimate (display only) → Simulate (fresh quote and simulation for the owner) → Review (Strategy
  Manifest) → Authorize → owner's wallet → FloFi broadcast or wallet send → observation → reconciliation.
- An estimate is never a Review input. Review re-quotes; `begin` re-quotes again and refuses any economic change
  (`QUOTE_CHANGED_REVIEW_REQUIRED`).
- Minimum output = expected × (10 000 − slippage bps) / 10 000; Review binds it.
- Latency work must keep these boundaries: cache only immutable, non-financial facts; issue independent reads
  together with ordered failure judgement; never reuse a quote, blockhash, signature or wallet payload.

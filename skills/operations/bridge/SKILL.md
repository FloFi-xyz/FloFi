# Bridge operation (FloFi engineering skill)

- Discovery is read-only and classifies every provider answer: EXECUTABLE (FloFi verified it), LIVE_QUOTE
  (comparison only), SUPPORTED_BY_PROVIDER, TEMPORARILY_UNAVAILABLE, NO_ROUTE and amount limits.
- The discovery window returns the first verified executable route after a short comparison window, bounded by a
  deadline; slower providers are aborted and named as pending (PROVISIONAL comparison). Late answers are discarded.
- Cross-chain states: origin submitted → origin confirmed → settlement pending → destination observed →
  reconciled. Origin confirmation is not settlement; a provider's status is not completion.
- Provider quotes in the legacy Router are independent and asked together, then folded in the reviewed preference
  order (selection unchanged).

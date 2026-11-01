# Across (FloFi engineering skill)

- FloFi's certified Router (`flofi.router`) bridges USDC/USDG pairs through Across SpokePool deposits, quoted
  directly or through LI.FI, and verified against the SpokePool's deposit event in simulation.
- A deposit is an origin-chain event. Settlement is a relayer fill on the destination before the fill deadline,
  or a refund on origin after it. Origin confirmation is never completion: FloFi observes the destination.
- The SpokePool `depositQuoteTimeBuffer` bounds how old a quote timestamp may be; Review expiry respects it.
- Across' public `/swap/approval` endpoint is used for discovery only; FloFi never executes a transaction it did not
  verify itself.

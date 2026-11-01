# Relay (FloFi engineering skill)

- Relay's Depository is the universal router's executable path across FloFi's five mainnets (including Solana).
  FloFi verifies the quote's transaction byte for byte before Review (`normalizeRelayQuote`).
- Discovery asks Relay together with the other providers; only Relay can produce an EXECUTABLE candidate, so the
  discovery window can answer once Relay's verified route arrives and the compare window passes.
- Settlement status comes from Relay's status API and the destination chain; a "success" from the API alone is
  never completion.

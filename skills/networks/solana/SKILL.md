# Solana (FloFi engineering skill)

## Transactions
- FloFi compiles v0 (versioned) messages with address lookup tables. Table contents are read from the chain
  (`verifyLookupTables`), never trusted from a provider response.
- A message references a recent blockhash; it is valid for a bounded number of blocks (`lastValidBlockHeight`).
  Review carries both; an expired blockhash requires a new Review, never a re-sign of old bytes.
- Compute: the compiler simulates once to measure units, then sets the limit (`units × 1.2 + 10 000`, capped) and
  simulates the exact final message again. Priority fee (compute-unit price) comes from the provider's
  compute-budget instruction and is capped (`JUPITER_PRIORITY_FEE_TOO_HIGH`).
- The owner signs the exact reviewed message (or it plus verified Lighthouse assertions); FloFi verifies the
  signed bytes against the Review before it broadcasts them once.

## Reads and latency
- Cluster identity is checked with `getGenesisHash`. The public mainnet-beta endpoint is rate-limited; FloFi's
  transport serializes calls with a short delay.
- Independent reads (cluster check vs provider HTTP; lookup tables vs balances vs blockhash) can overlap when their
  failures are judged in the original order.

## Never
- Never ask for, print or store a secret key or seed phrase. Signing happens in the owner's wallet (Privy embedded or
  external Wallet Standard wallet) after FloFi's gate.

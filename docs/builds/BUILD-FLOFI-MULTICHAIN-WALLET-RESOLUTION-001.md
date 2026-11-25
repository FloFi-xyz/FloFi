# BUILD-FLOFI-MULTICHAIN-WALLET-RESOLUTION-001

Branch `fix/multichain-wallet-resolution-001`

Base `6e07bad42dd85e28926ded1b146199ae0f62caf7` (PR #250, verified against fetched `origin/main`)

## Incident and implementation

- The Build card used its EVM address as a fallback when it had no Solana address. The BFF selected any string for Jupiter's second preview argument. Railway checked that argument with the Solana address validator before calling Jupiter, so an EVM address produced HTTP 400 `ARGUMENTS_INVALID`. This is established from the request path. The supplied production log entries do not include the request body.
- The mainnet swap estimate now ignores dashboard wallet selection. Jupiter sends the established public Solana quote subject, and the backend uses it only for the market read. Solana transaction simulation still requires the operation wallet.
- The Editor's step-by-step Review and connection action now use the active step's chain. The account and browser keep their existing separate EVM and Solana sessions.

## Validation and handoff

- Baseline engineering inventory, impact and Agent Evolution passed. No production funds were used.
- Resumed from the working diff on the base above. GitHub confirmed the branch had zero local commits and no published branch or PR. The previous session left 41 modified files, this ledger, and focused logs under `/tmp/flofi-wallet-resolution-*.log`. It had also initialized a disposable PostgreSQL server and downloaded digest-verified Anvil v1.8.3.
- Recovered security, swap, workflow, wallet, bridge, MCP and developer handbacks. Their rebuilt checks passed, including 159 swap, 250 bridge and 45 MCP cases. The prior run's sequence assertion failed before its corresponding test edit. The resumed incident, preview, Review and restoration run passed 85 cases in four files.
- Incremental reviews exercised the changed security, workflow, channel, bridge and frontend boundaries. The resumed quote path keeps its quote subject out of Review, follows the preview deadline, and reports quote-only evidence in MCP, Telegram and Developer API. Explicit public simulation addresses are accepted by ecosystem. Linked-wallet reads are limited to scoped MCP links with the balance disclosure.
- The closed-beta account admission and operation-specific owner checks now follow the active step and the durable flow owner. Bridge begin and handoff bind the Review commitment and attempt. A sequential approval pins an implicit bridge recipient to the claimed destination wallet. A stale or mismatched destination cannot be substituted before the wallet request. Existing observation continues after durable handoff.
- The new loopback PostgreSQL journey passed from an exact native ETH input through Base USDC, Relay delivery to the claimed Solana wallet, and Jupiter. The fixture also refused a different recipient before handoff and used the reconciled 8.5 USDC in Jupiter. Existing reverse-direction and legacy Relay proof checks remain enabled.
- Local full checks and reviewer follow-through are in progress. Logs use `/tmp/flofi-wallet-resume-*`. Current published SHA and certification are pending. Next action is to publish the coherent checkpoint, open the PR against main, and monitor the exact revision in CircleCI and Vercel.

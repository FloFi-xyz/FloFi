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
- Published implementation checkpoint `2de5465bcccf6f6d3d4b783087f3c1f0d809314a` on the expected branch. On the local check, typecheck, lint, the production build and schema drift passed. The unit run passed 10,159 cases and found failures in the channel boundary check, position mock setup and the superseded walletless quote expectation. The database run passed 1,026 cases and found failures in the superseded API schema expectation and the Telegram fixture started before signal propagation was complete.
- Corrected those failures and reran the affected suites on this checkpoint's follow-up. Eight focused lifecycle, preview and authority files passed 257 tests, the three unit failure suites passed 21 cases, and the three affected PostgreSQL suites passed all 33 cases. Logs use `/tmp/flofi-wallet-resume-*`. These are local fixture results.
- The next action is to open the PR against main and check CircleCI certification and Vercel Preview for its exact HEAD. Owner-wallet and hosted ChatGPT, Claude and Telegram acceptance require owner participation. Competing identical legacy handoffs with different bound recipients fail closed when the existing identity cannot disambiguate them.
- For a future authorized rollout, the Railway API must recognize the commitment-bound begin and attempt-bound handoff before the Vercel client enables the new path. The new backend accepts both client versions. A new client talking to the old API fails closed before the wallet prompt.

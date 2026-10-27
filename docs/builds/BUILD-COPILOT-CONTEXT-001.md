# BUILD-COPILOT-CONTEXT-001

Base revision: `d44d6afc3e6b0f20f9fddb2f32e5a3c0937aa28f`, fetched from `origin/main` before editing.

## Demonstrated causes

1. `planBridge` compared the model destination with the user destination before catalog validation. A contradiction produced an `asset` question instead of retaining the explicit user destination. Resolution errors also became a false comparison, disguising catalog unavailability as that same question.
2. `stopped` retained drafts only for questions with deterministic buttons, a bare amount, or an Orca deposit maximum. An open destination question with no buttons therefore stored `draft: null`. Some destination questions also supplied an empty missing-field list.
3. A subsequent model action replaced the request rather than updating a persistent structured draft. The transcript supplied grounding text but did not protect already settled fields from model omission or substitution.
4. Browser catalog preparation occurred after a successful model response. Local clarification answers did not perform that preparation, and `ensureNetworkCatalog(false, ...)` retained an earlier unavailable state.
5. The model parser placed explicit `address@decimals` references inside the shorter token-name length limit. A complete EVM contract plus decimals exceeded it.

Two failing tests were run before changing production code. A separate `git archive` of the base revision was subsequently exercised with the exact Portuguese USDT request and the isolated catalog fixture from `copilot-context.test.ts`. With a model destination of USDC it produced:

```text
quero bridge de 1 usdc na base para usdt na arbitrum
AssertionError: Qual ativo você quer receber na Arbitrum One?
expected 'CLARIFICATION' to be 'PROPOSAL'

expected null to match object { expected: ['outputAsset'] }
```

The user-provided production transcript contains no captured structured model response or catalog-loader result. The precise production model output is therefore a hypothesis, not asserted as observed evidence. The contradictory-output and unavailable-catalog paths are independently reproducible code defects. Omitted output, incorrect output, and recovery are all tested.

## Shared pipeline

The existing strict model contract still supplies language understanding. A deterministic draft merger now preserves unrelated action fields, composition steps, liquidity maxima, and automation fields. Explicit asset-role clauses protect user input from omitted or contradictory model asset fields; arbitrary prose continues through the interpreter. Symbols are never checked against a conversational whitelist.

Every planner question retains its intent, expected fields, context snapshot, bounded user grounding, and slot/chain-specific validation evidence. A short answer fills its typed slot, then traverses the same planners, catalog resolvers, canonical grammar, command validation, editor preview, and proposal gates. Unanswered/invalid values remain unresolved. The clarification budget resets only when a new value validates. Read-only questions, recoverable catalog failures, and failed model calls preserve the active request; changed workflow, proposal, or wallet invalidates it.

Asset lookup remains scoped to the selected chain. It supports catalog symbols, whole names, known contract addresses, and known contract-plus-decimals references. Invalid references, mismatched decimals, ambiguous identities, unknown tokens, and unavailable catalogs remain distinct. Universal Bridge continues to support explicitly user-grounded contract/mint references that simulation must verify on chain. Model-invented references cannot pass grounding.

Browser turns prepare both draft networks before local answers as well as after model interpretation, including the existing verified Solana loader. Failed catalog reads retry on the next turn. Channel Core uses the same pure engine and preserves its typed draft through JSON persistence. MCP and integrated channels continue through their existing canonical strategy path; their existing input syntax and trust boundaries remain authoritative.

Certified Router pairs retain their existing authoring path. Independent/cross-asset requests select Universal Bridge. Recognizing a token grants no route, quote, liquidity, execution eligibility, or authorization. Existing discovery, simulation, review, wallet, fee, slippage, mainnet scope, reconciliation, trust-origin, tenant-isolation, and privacy boundaries remain in force. No execution engine, layout, or financial policy was changed.

## Coverage map

| Required case | Evidence |
| --- | --- |
| 1–2. Base USDC to Arbitrum USDT/WETH | `domain/copilot-context.test.ts`: chain-scoped asset and command matrix |
| 3. Same-asset bridge | Certified Router regression in that matrix; existing Arbitrum/Router parity suites |
| 4. Token names | Wrapped Ether, Wrapped BTC; existing catalog and SPL name parity |
| 5. Contract/mint and decimals | Known EVM address, explicit `@6`, wrong decimals, invented reference; existing SPL parity |
| 6. Symbol casing | `usdt`, `USDT`, `uSdT`; catalog case regressions |
| 7. Missing output plus one-token answer | Typed cbBTC-to-Solana draft; persisted Solana-to-Robinhood channel and browser journeys |
| 8–9. Model omits/substitutes explicit token | Both structured-output cases assert the correct independent canonical identities |
| 10. Two corrections | WETH → USDT → LINK; source and amount retained |
| 11. Token absent from loaded catalog | AERO and numeric-leading 1INCH refusal on the existing Arbitrum list projection; no substitution |
| 12. Catalog failure and recovery | Domain recovery and `state/copilot-catalogs.test.ts`, including verified Solana loading |
| 13. Asset versus provider/route failure | Unknown/unavailable asset assertions plus existing universal discovery, Relay/provider, build-estimate and service suites |
| 14. Context changes | Wallet, wallet chain, workflow, pending proposal, and in-flight model answer |
| 15. Other actions | Swap, Transfer, Lending, Liquidity, supported Composition and Automation draft clarifications |
| 16. Portuguese and English | New PT/EN matrix plus the existing bilingual eval corpus |
| 17. Surface parity | Canonical workflow hashes compared with strategy composition; actual persisted Channel Core turn; existing MCP gateway/security suites |
| 18. No repeated valid question | Final replies assert proposals with no options; local turns assert no model request; four successful clarifications preserve the request |

The new matrix uses USDT, WETH, LINK, DAI, WBTC, USDC.e, cbBTC, AERO, EURC and USDC across Base, Arbitrum and Solana. Channel/browser clarification additionally uses Robinhood Chain's USDG. Known Ethereum and arbitrary verified SPL identities remain covered by the existing parity suites. Provider/list fixtures are isolated test infrastructure, never production fallbacks.

Existing assertions were updated only where they encoded the defective behavior: a contradictory model destination must now yield the explicitly requested canonical destination, and a missing catalog must report unavailable rather than declaring a named token unsupported. Typed automation question assertions additionally verify their missing fields. Security assertions were retained.

## Certification commands

```sh
pnpm check
TEST_DATABASE_URL=<disposable-loopback-postgres> pnpm test:postgres
node scripts/guarded-release-browser.mjs profile copilot
node scripts/guarded-release-browser.mjs profile universal-bridge
node scripts/guarded-release-browser.mjs profile chat-automations
node scripts/guarded-release-browser.mjs profile copilot-learning
python3 -m unittest discover -s scripts -p 'test_governance_lite.py'
python3 -m unittest discover -s scripts -p 'test_ci_*.py'
python3 scripts/governance_lite.py
git diff --check
```

Browser commands require the repository's pinned headless-shell and Anvil paths, telemetry/download controls, and loopback fixtures as specified by `playwright.config.ts`. CircleCI remains the required certification system, using the unchanged governance, certification-checks, browser shards, and certification fan-in ledger. Final head SHA, local results, CircleCI links/statuses, and any failures are recorded in the PR delivery evidence rather than inferred from this document.

## Existing limitations

- Catalog inclusion is the existing registry/list projection's decision. Conversation code does not widen provider inclusion rules (for example numeric-leading records excluded by an existing list projection).
- Token membership does not prove route existence or executable provider support. Relay and the certified Router retain their existing execution capabilities; quote-only/provider limitations remain explicit at the existing discovery and review gates.
- Dependent mainnet compositions and automation routes remain limited to the existing engine capability registry. A conversation fix does not create a financial capability.
- The pure intent/draft pipeline has no model-name branch. This repository's live Copilot transport still targets OpenAI Responses; no new Anthropic transport or live GPT/Claude quality certification is claimed. MCP clients continue to supply their supported structured requests independently of client model.
- Transcript and active grounding remain bounded by the existing request-size policy. Ambiguous multi-step references still require interpretation or clarification rather than guessing a financial field.
- PostgreSQL's existing three forward-schema certificate cases are inapplicable when no certificate names the current schema head. Two existing unit smoke cases require owner-local fork profiles. These conditions are reported as skips, never passes; ordinary unit, isolated PostgreSQL, fork/browser and CircleCI results must be assessed separately.

No real transaction, deployment, merge, production database change, secret change, or infrastructure mutation is part of this build.

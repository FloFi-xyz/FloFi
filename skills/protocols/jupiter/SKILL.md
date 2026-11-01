# Jupiter Swap API (FloFi engineering skill)

## What FloFi uses
- `GET https://api.jup.ag/swap/v2/build` (Metis routing, raw instructions). FloFi assembles, simulates and compiles
  the v0 transaction itself. It does not use `/order`, `/execute` or Jupiter's `/submit` landing service.
- Query: `inputMint`, `outputMint`, `amount`, `taker`, `slippageBps`, `wrapAndUnwrapSol=true`, `maxAccounts=64`.
  Every economic field of the response must equal the intent (`parseJupiterBuild`); unexpected instructions,
  signers, fees or recipients fail closed (`inspectJupiterInstructions`).

## mode=fast (evaluated, not enabled)
- Jupiter documents `mode=fast` on `/build` as BETA: Bellman-Ford routing with no route splitting, and a
  priority-fee lookup run in parallel with routing that estimates fees globally rather than from the route's hot
  accounts. It trades quote optimality and fee accuracy for latency.
- FloFi's Review binds the minimum output and caps the priority fee, so a worse route or a mis-estimated fee is a
  real cost to the owner. Enable it only after a measured comparison (latency, minimum output, compute and fee on
  the same pairs and sizes) and an owner decision. A unit test guards that Review sends no `mode`.

## Never
- Never add platform fees, tips (`tipAmount`) or a payer without an explicit, reviewed product decision.

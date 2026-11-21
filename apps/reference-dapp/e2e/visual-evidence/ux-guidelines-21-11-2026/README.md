# UX-01 · UX-02 · UX-03 · UX-05 · UX-06 visual evidence (owner guidelines of 21-11-2026)

Each image compares `main` before this change (**ANTES**) with this branch (**DEPOIS**) on the same scenario, viewport and language, and — where
the guidelines give one — the approved reference (Annex D for Simulate, G for the expired Review) or the "current state" annex the guideline
corrects (C, E, F). References A and B (Create toolbar, UX-04) are out of scope and are not used.

Scenario: the references' two-step workflow (Swap 3 USDC → WETH on Base, then Send 0.0008 WETH to `0x2820…912edc`) in Portuguese, captured by
`e2e/ux-refinement-evidence.spec.ts` on the MOCKED loopback user-funded profile (no public chain, no real wallet; nothing is signed or sent). The
before and after renders use the same spec, viewport (1440 × 900 and 1815 × 866, the references' size) and the 390 px phone. Quotes and
addresses are MOCKED fixtures, so the amounts differ from the references' illustrative AAVE/Arbitrum figures.

| Image | Shows |
| --- | --- |
| `ux01-simulate-awaiting.jpg` | UX-01 Simulate before a simulation, against reference D |
| `ux01-ux05-simulate-result.jpg` | UX-01 result card and UX-05 "Continuar para autorização" in the panel (footer status only), against annex C |
| `ux02-header-1440.jpg`, `ux02-header-1815.jpg`, `ux02-create.jpg` | UX-02 the same header row, height and stepper position on Create, Simulate and Execute, against annex E |
| `ux03-execute-valid.jpg`, `ux03-review-panel.jpg` | UX-03 the valid Review, against annex F (current state before) |
| `ux03-execute-expired.jpg` | the expired Review (kept), against reference G |
| `mobile-390.jpg` | the Simulate result and the Review at 390 px |

Images are JPEG (quality 82), downscaled to at most 2400 px wide.

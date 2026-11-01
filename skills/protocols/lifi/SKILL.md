# LI.FI (FloFi engineering skill)

- LI.FI is a routing provider in discovery (`/advanced/routes`) and a quote source for the certified Router's
  Across pairs. A LI.FI route is executable in FloFi only where FloFi's own verifier checks the resulting
  transaction (the certified Across pairs); every other LI.FI route is LIVE_QUOTE (comparison only).
- Tool names in a route are not proof of anything: FloFi decodes and verifies the calldata itself.
- Provider fees (including LI.FI's fixed fee) are listed in Review; FloFi never adds an integrator fee silently.

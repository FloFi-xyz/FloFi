# BUILD-FLOFI-SITE-001 visual evidence

Each image puts the approved Claude Artifact "FloFi — site aprovado" (version `1793715580-4561`) on the left and this branch on the right, at
1440 px (`*-desktop`) and 390 px (`*-mobile`), full page. The Artifact side was rendered locally from its own board markup (`<board>.dc.html`,
closed, `file://`, no network). Its IBM Plex Mono falls back to the system monospace there, so its mono labels look smaller than they are. The
implementation side is this branch's production build on loopback, with the language set by the product's `flofi_language` cookie.

Boards: `Main`, `ComoFunciona`, `Desenvolvedores`, `Docs`, `Docs-simulation`, `Docs-developer-api`, `Docs-mcp-integrations` and the `EN-`
counterparts of `Main`, `ComoFunciona`, `Desenvolvedores`, `Docs`, `Docs-getting-started` and `Docs-mcp-integrations`. The visible
differences are the deliberate ones in `docs/builds/BUILD-FLOFI-SITE-001.md`: the real API paths and the approvals step, what today's keys do,
the webhooks wording, the MCP availability row, and phones wrapping where the board scrolls sideways (`Desenvolvedores` at 390 px).
Images are downscaled (1600 px / 900 px wide, 128 colours).

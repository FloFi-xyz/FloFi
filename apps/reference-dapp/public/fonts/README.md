# FloFi product fonts

Outfit and IBM Plex Mono are distributed under SIL OFL 1.1; the complete copyright notices and licenses are adjacent in `Outfit.OFL.txt` and `IBM-Plex-Mono.OFL.txt`.

These 12 WOFF2 files are byte-for-byte copies of the Google Fonts payloads already used by the successful local production build of FloFi commit `17e32a70d41a6dc9be721382727706d34f03207f` on 2026-10-28. No glyphs, subsets or binary metadata were edited. `manifest.json` records each SHA-256, size, family, weight, Unicode range and the same three Latin preloads. Source families: [Outfit](https://github.com/google/fonts/tree/main/ofl/outfit), [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono).

`src/app/fonts.css` preserves the generated font faces, weights, ranges and fallback metrics. Only file locations and the variable selector change. Browser font requests remain on the FloFi origin. Builds no longer fetch Google CSS or enter the failing Next.js 16.4.1 Google-font URL parser documented in [vercel/next.js#99114](https://github.com/vercel/next.js/issues/99114). No package, lockfile, screenshot baseline or financial behavior changes.

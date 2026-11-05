# Native token and network logos

These local assets retain their source colors in both themes. Logos and trademarks remain owned by their respective brands; they are not covered by the application's AGPL source license.

- USDC: https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png
- Ethereum: https://ethereum.org/images/assets/svgs/eth-glyph-colored.svg (https://ethereum.org/assets/)
- Solana: https://solana.com/src/img/branding/solanaLogoMark.svg (https://solana.com/branding)
- USDT: https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color/usdt.svg (CC0 1.0; included license)
- Base: https://raw.githubusercontent.com/base/brand-kit/a3b352afcc0839a0a355ccc2ae3279442fa56343/logo/symbol/Base_Symbol_Blue.svg (original circular chain mark from the official brand kit)
- Arbitrum: https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png
- Optimism: https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/optimism/info/logo.png

Robinhood continues using the existing unmodified avatar and its recorded source at ../robinhood-avatar.source.md.

## BUILD-BRAND-UX-001 marketing additions

- BTC: original artwork from [BitPay's Bitcoin brand repository](https://github.com/bitpay/bitcoin-brand), `https://raw.githubusercontent.com/bitpay/bitcoin-brand/master/bitcoin.svg`, downloaded 2026-10-09. SHA-256 `3672ebaa9a2c6e7490636c8f3fc093ed1601f9aca103f164a6926cd1a5488d77`. Served SVG uses LF line endings and trimmed line-end whitespace, with identical parsed artwork; served SHA-256 `5083e5447d66c4654977a891c79d3abd3fb03c2a5e6b759458c70147cd48bd9f`. The source's CC0/public-domain dedication is preserved byte-for-byte in `bitcoin-brand.LICENSE` (SHA-256 `6d489af6292662d9e36d34ce49423784984a5f6e41d7b58f49b01264df59fa03`).
- WBTC: unmodified token icon from [Trust Wallet's asset registry](https://github.com/trustwallet/assets/tree/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599), `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png`, downloaded 2026-10-09. SHA-256 `488ed9e5d7ca087193df45676173c580b2fb8b9fd40ab90619f910029cc1ae28`. Identifies Wrapped BTC; excluded third-party brand material, with no FloFi source-license or trademark grant.

The landing reuses the existing ETH, USDC, SOL, Base and Arbitrum assets above without recoloring, cropping or stretching. All are self-hosted. Icons and protocol names identify illustrative scenarios, not partnerships, enabled mainnet capabilities or verified execution. BTC and WBTC are explicitly distinct. No wallet, transaction or runtime token mapping is changed.

## AAVE-V3-CARD-CATALOG-FIX-001 token marks

Source: the `cryptocurrency-icons` npm package, version 0.18.1 (CC0-1.0), tarball `https://registry.npmjs.org/cryptocurrency-icons/-/cryptocurrency-icons-0.18.1.tgz` (integrity `sha512-dvR5O8JOmav3559Yb0Igpkia+3vpt/aeNvMu5ZIVUG2Bzpq9wNcOJRIQas49XJrPjtZ98GAEn3aDQO+w7uhS2w==`, SHA-256 `03334621204a65309bcdb295548e762fce5b8e5286b4822e8ad3777efd966189`), downloaded 2026-11-05; upstream repository https://github.com/spothq/cryptocurrency-icons. The package's `LICENSE.md` is byte-identical to the included `cryptocurrency-icons.LICENSE.md` (SHA-256 `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499`). Each file below was inspected before copying: plain vector (`svg`, `g`, `circle`, `path` only), square `0 0 32 32` viewBox, no script, event handler, `foreignObject`, DOCTYPE/entity, external reference or `url()`.

| Served file | Tarball path | SHA-256 (served) |
| --- | --- | --- |
| `tokens/eth.svg` | `package/svg/color/eth.svg` (source SHA-256 `1f94df8533f61806f7b17eaf9cd28678cdba66e1d82a9ca8f9fb38d35a907e9c`; only `width="32" height="32"` added to the root element) | `f8ad1d2e8f172f83572de008588660be0821fd3626f7a1402c0c8f7d2e706969` |
| `tokens/dai.svg` | `package/svg/color/dai.svg` (unmodified) | `030fdb32f1563c8d0997ff87940587a65af3a41171bba668f55b361d5ce6b561` |
| `tokens/link.svg` | `package/svg/color/link.svg` (unmodified) | `2457990f68e333130633497d20456de38af8421aba8fdb4149900e4e051f10fa` |
| `tokens/aave.svg` | `package/svg/color/aave.svg` (unmodified) | `0884e64b1b44256a2c1dd4e2a195e7c929bf5b516c09d3f847f334b25ef6f878` |
| `tokens/wbtc.svg` | `package/svg/color/wbtc.svg` (unmodified) | `3a57d25e32ace908c7a33d8ca3e30b8f6eda95eff2604799c504a4509bd657f5` |
| `tokens/uni.svg` | `package/svg/color/uni.svg` (unmodified) | `2a3192f07ade04f86a45b30de0b006400803b84488b2d4266a4dd33cda192773` |
| `tokens/crv.svg` | `package/svg/color/crv.svg` (unmodified) | `cbdd5669bfe5b3d38e08bff83e9186d57561ff79cda39507742ca640c62f6f86` |
| `tokens/mkr.svg` | `package/svg/color/mkr.svg` (unmodified) | `b0f766e536978c5675b9884219f0738ad729b0a075b073e62a2484c73c78ebf6` |
| `tokens/snx.svg` | `package/svg/color/snx.svg` (unmodified) | `a76e2f20585d41d3083dd2e56b1ef8bbe2bf660c70412e0eec7090d1f61d7bfd` |
| `tokens/bal.svg` | `package/svg/color/bal.svg` (unmodified) | `2fec2636e6426cdc2dac40a2bf262263b2bb8b6dd56f52df5ab933e85997cee6` |
| `tokens/1inch.svg` | `package/svg/color/1inch.svg` (unmodified) | `6e2b48d4322c61da0831c804fdf1b72f03c4afee4b71152ea0daa1068946fc8c` |
| `tokens/knc.svg` | `package/svg/color/knc.svg` (unmodified) | `2ad3c9c95091945b911b548825348bcc2c02908954a0be64ea2998dfb60366d7` |

The existing `usdt.svg` above is byte-identical to `package/svg/color/usdt.svg` of the same release (SHA-256 `cddba428a029844888b59bae59c6400ee684b0d51dfc490a4374eef6bb63ea16`).

- `ethereum-network.svg` (Ethereum network badge, SHA-256 `90334e22161fa77d1c7ea82160d0319031aa1115230dd0cfb9c02d065770537d`): a FloFi derivative of `package/svg/color/eth.svg` above (CC0-1.0, so modification is permitted). The six glyph paths and their fill opacities are unchanged; the glyph is filled with the source's `#627EEA` and drawn on a white disc with a 1.5-unit `#627EEA` ring, the inverse of the ETH token mark, so the network badge stays sharp at 12-18px and never reads as the ETH token.

Use: the ETH/WETH token mark of every network is `tokens/eth.svg` (square, crisp at 12-22px); `ethereum.svg` above is no longer a token or network mark in the resolver and remains only for the surfaces that still reference it (wallet ecosystem tabs and the secondary product workspace). The other `tokens/*` marks are shown only for a registered Aave V3 reserve, matched by chain and underlying address, never by symbol. Reserve underlyings without a CC0 mark in this release (for example LDO, ENS, FRAX, FXS, RPL, ARB, GHO and the liquid-staking and Pendle tokens) keep their generated monogram; none is invented.

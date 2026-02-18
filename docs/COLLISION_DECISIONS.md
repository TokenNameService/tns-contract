# Token Symbol Collision Decisions

During genesis seeding validation, we identified 19 cases where multiple tokens claimed the same on-chain metadata symbol. This document records our manual decisions for each collision.

## Decision Criteria

1. **Symbol Match**: If one token's Jupiter/source symbol matches the metadata symbol exactly, it wins
2. **Source Priority**: Jupiter Cache > Orca/Raydium > Solana Token List (deprecated)
3. **Token Legitimacy**: Canonical bridges (Wormhole, Portal) preferred over deprecated bridges (Sollet)
4. **Skip if unclear**: When neither token is clearly correct, skip to avoid seeding wrong data

---

## Collisions with Clear Winners (15 groups)

These tokens will be moved to the valid list and seeded:

| Metadata Symbol | Winner | Mint | Source | Loser(s) |
|-----------------|--------|------|--------|----------|
| **USDC** | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | jupiter-cache | sUSDC-8 (solana) |
| **USDT** | USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | jupiter-cache | sUSDT-8 (solana) |
| **SRM** | SRM | `SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt` | jupiter-cache | SRMSOL (solana) |
| **LINK** | LINK | `2wpTofQ8SkACrkZWrZDjXPitYa8AwWgX8AfxdeBRRVLX` | solana | soLINK (jupiter-cache) |
| **MIM** | MIM | `HRQke5DKdDo3jV7wnomyiM8AA3EzkVnxMDdo2FQ5XUe1` | jupiter-cache | wMIM (solana) |
| **KING** | KING | `9noXzpXnkyEcKF3AeXqUHTdR59V5uvrRBUZ9bwfQwxeq` | jupiter-cache | SHAKING (solana) |
| **SSHIB** | SSHIB | `7zphtJVjKyECvQkdfxJNPx83MNpPT6ZJyujQL8jyvKcC` | orca | $SSHIB (jupiter-cache) |
| **TAP** | TAP | `CejQBkdRPN8Jyod2jVUYTfHwU9hPHvM3rD9prvQiffDU` | jupiter-cache | KIRA (jupiter-cache) |
| **ALEPH** | ALEPH | `3UCMiSnkcnkPE1pgQ5ggPCBv6dXgVUy16TmMUe1WpG9x` | jupiter-cache | wALEPH (solana) |
| **SUSHI** | SUSHI | `ChVzxWRmrTeSgwd3Ui3UumcN8KX7VK3WaD4KGeSKpypj` | jupiter-cache | soSUSHI (solana) |
| **YFI** | YFI | `3JSf5tPeuscJGtaCp5giEiDhv51gQ4v3zWg8DGgyLfAB` | jupiter-cache | soYFI (solana) |
| **DAI** | DAI | `EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o` | jupiter-cache | DAIpo (solana) |
| **MP** | MP | `5zYbnE6UXTn6HMTPXCNPW61iA1vyCNTZLVQdUUnoazB` | jupiter-cache | BMP (solana) |
| **STAR** | STAR | `D7U3BPHr5JBbFmPTaVNpmEKGBPFdQS3udijyte1QtuLk` | orca | SATM (orca) |
| **TRASH** | TRASH | `CGTXWnsZiJExZcCTaEKdXP5c7TL733bJo3ttqhtC1Gf1` | solana | DTPT (solana) |

---

## Collisions Skipped (4 groups)

These tokens will NOT be seeded:

### BTC
- **batcat** (BMP4Wvjz3hU45gsJSxXE3wpj8B9Dvjs5JFdpQ3raBvTn) - Meme coin, not real Bitcoin
- **soBTC** (9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E) - Deprecated Sollet bridge

**Reason**: Neither is canonical Bitcoin. Users should use `WBTC` (Wormhole) or `cbBTC` (Coinbase) instead.

### BUSD
- **BUSD** (5RpUwQ8wtdPCZHhu6MERp2RGrpobsbZ6MH5dDHkUjs2) - Sollet bridged
- **soUSD** (2PXXaTXWXdscULBUCvQHs4B3WE5EuxGFFBX5ztkYVPdm) - Solana wrapped

**Reason**: Binance officially deprecated BUSD in 2023. Not worth seeding.

### NFT
- **Ras** (5TPYH5sMvFMitzsjzM9xrxq5igpVuGugVu8CLzCrFdFW) - Symbol doesn't match metadata "NFT"
- **SCMM** (CCPSqDhvJtJpovDRfKdWsVLdo5aYoJumV3f38y2CXhCz) - Symbol doesn't match metadata "NFT"

**Reason**: Neither token's symbol matches its metadata. Unclear which (if any) should own "NFT".

### EVRY
- **bEVRY** (FDo4TPENcKdHtWMV56PSEjJmFfWUSRotLgW1EbPHreCB) - Symbol doesn't match metadata "EVRY"
- **eEVRY** (6oYoyFahkKxyvjsdt8JtRr4AQHvvwHEJthwqxQjei2gi) - Symbol doesn't match metadata "EVRY"

**Reason**: Neither token's symbol matches its metadata. Unclear which (if any) should own "EVRY".

---

## Summary

| Category | Count |
|----------|-------|
| Valid tokens (pre-collision) | 2,358 |
| Collision winners added | 15 |
| Collision losers removed | 15 |
| Collisions skipped entirely | 8 tokens (4 groups) |
| **Final valid tokens** | **2,373** |

---

## Notes

- All decisions prioritize on-chain metadata as source of truth
- Solana Token List tokens (deprecated July 2022) were deprioritized
- Jupiter Cache and major DEX sources (Orca, Raydium) were trusted
- When in doubt, we skip rather than seed incorrect data

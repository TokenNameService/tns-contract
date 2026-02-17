# Verified Token Fetcher - Collision Resolution Logic

This document explains how `fetch-verified-tokens.ts` resolves symbol collisions.

## Collision Resolution Logic

For each symbol, the following decision tree is applied:

```
IF only 1 candidate:
  → winner (no collision)

ELSE IF market data shows clear winner:
  → highest volume wins
  → add to collisionAudit[] as "market-cap"

ELSE IF no market data at all:
  IF all candidates are Jupiter:
    → EXCLUDE from seeding
    → add to collisionAudit[] as "excluded"
    → add to pendingCollisions[]
    → skip adding to finalTokens
  ELSE:
    → Jupiter wins by source priority
    → add to collisionAudit[] as "source-priority"

ELSE (edge case):
  → first source wins
  → add to collisionAudit[] as "source-priority"
```

## Key Concept: Same Mint vs Same Symbol

**Same mint, different sources (NOT a collision - skip):**
```
Jupiter Cache:  USDC → EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Solana List:    USDC → EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
                       ↑ Same mint appearing in both lists
```
This is the same token listed in multiple sources. We skip the duplicate.

**Same symbol, different mints (THIS IS a collision):**
```
Jupiter Cache:  USDC → EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Some source:    USDC → 7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT
                       ↑ Different mints claiming same symbol
```
This is two different tokens fighting for the same symbol. This requires resolution.

## Deduplication Logic

```typescript
const seenMints = new Set<string>();  // Track mints globally

for (const { name, tokens } of allSources) {
  for (const token of tokens) {

    // If this exact mint was already processed from a higher-priority source
    if (seenMints.has(token.address)) {
      skip++;  // Same token, different source - not interesting
      continue;
    }

    seenMints.add(token.address);

    // Add this mint as a candidate for this symbol
    symbolCandidates[token.symbol].push({
      mint: token.address,
      source: name
    });
  }
}

// After processing all sources:
// - Symbols with 1 candidate → no collision
// - Symbols with 2+ candidates → collision (different mints want same symbol)
```

**Example walkthrough:**

| Source | Symbol | Mint | seenMints | Action |
|--------|--------|------|-----------|--------|
| jupiter-cache | USDC | EPjF... | `{EPjF...}` | Add to candidates["USDC"] |
| jupiter-cache | AVAX | KgV1... | `{EPjF..., KgV1...}` | Add to candidates["AVAX"] |
| jupiter-cache | AVAX | AUrM... | `{EPjF..., KgV1..., AUrM...}` | Add to candidates["AVAX"] ← **collision!** |
| solana | USDC | EPjF... | (already in set) | **Skip** - same mint, different source |
| solana | USDC | 7kbn... | `{..., 7kbn...}` | Add to candidates["USDC"] ← **collision!** |

Result:
- `candidates["USDC"]` = 2 mints → collision
- `candidates["AVAX"]` = 2 mints → collision

The "skipped" count represents tokens where the exact same mint already appeared in a higher-priority source. These aren't collisions - they're just the same token listed multiple times.

## Output Files

| File | Purpose |
|------|---------|
| `verified-tokens.json` | Final token list for `seed-genesis.ts` |
| `collision-audit.json` | Complete audit trail of every collision decision |
| `pending-collisions.json` | Symbols excluded from seeding (first-to-register wins) |

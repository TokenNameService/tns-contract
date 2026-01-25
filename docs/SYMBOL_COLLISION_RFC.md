# RFC: Symbol Collision Resolution for TNS

## Overview

TNS (Token Naming Service) aims to provide a unified namespace for both crypto tokens and real-world assets (RWA). However, there are significant symbol collisions between existing Solana tokens and traditional finance ticker symbols.

This document outlines the collision data and presents options for community discussion.

## Collision Summary

| Category | Count |
|----------|-------|
| Verified Crypto Tokens | 11,859 |
| RWA Symbols (Stocks/ETFs) | 85,274 |
| **Symbol Collisions** | **2,150** |

### Collisions by Index

| Index | Collisions | Notable Examples |
|-------|------------|------------------|
| Dow Jones | 14 | AAPL, AMZN, MSFT, JPM, DIS, NVDA |
| S&P 500 | 141 | AMD, META, COIN, SQ, SHOP, UBER |
| NASDAQ 100 | 4 | MRVL, MSTR, SHOP, TEAM |
| S&P 400 | 103 | ALLY, BILL, WOLF, OPEN |
| S&P 600 | 124 | BANC, ROCK, SAFE |
| FMP Stocks/ETFs | 1,764 | (various) |

### Example Collisions

These symbols exist as both crypto tokens AND stock tickers:

| Symbol | Crypto Token | Stock/RWA |
|--------|--------------|-----------|
| AAPL | Apple Inc (tokenized) | Apple Inc (Dow, S&P 500) |
| AMZN | Amazon (tokenized) | Amazon (Dow, S&P 500) |
| CAT | Catcoin | Caterpillar (Dow) |
| DIS | Dissenter Coin | Disney (Dow) |
| HD | HD Crypto Token | Home Depot (Dow) |
| V | Vertical | Visa (Dow) |
| AMD | AMD (tokenized) | Advanced Micro Devices (S&P 500) |
| COIN | Coinbase (tokenized) | Coinbase (S&P 500) |

> **Full collision data**: See [symbol-collisions.json](../contract/scripts/data/symbol-collisions.json)

## The Problem

When a user registers or searches for "AAPL" in TNS:
- Are they referring to Apple stock (RWA)?
- Or a Solana token with the AAPL symbol?

Without disambiguation, this creates confusion and potential for:
- Trademark/brand conflicts
- User confusion
- Fraud (fake tokenized stocks)

## Options to Consider

### Option 1: Top-Level Domain (TLD) Namespaces

Use TLD-style suffixes to disambiguate asset types:

```
AAPL.stock   → Apple Inc (RWA)
AAPL.token   → Solana token
AAPL.meme    → Meme token
AAPL.utility → Utility token
```

**Possible TLDs:**
| TLD | Description |
|-----|-------------|
| `.stock` | Equities, stocks |
| `.etf` | Exchange-traded funds |
| `.rwa` | Real-world assets (general) |
| `.token` | Generic crypto token |
| `.meme` | Meme tokens |
| `.utility` | Utility tokens |
| `.defi` | DeFi protocol tokens |
| `.nft` | NFT collection tokens |
| `.stable` | Stablecoins |
| `.wrapped` | Wrapped assets |

**Pros:**
- Clear disambiguation
- Extensible for future asset types
- Familiar pattern (like DNS)

**Cons:**
- More complex UX
- Requires users to know/specify TLD
- Migration complexity for existing tokens

---

### Option 2: RWA Reserved Namespace

Reserve all RWA symbols in the root namespace. Crypto tokens must use a prefix or suffix.

```
AAPL       → Reserved for Apple Inc (RWA)
xAAPL      → Crypto token
AAPL-SOL   → Crypto token on Solana
```

**Pros:**
- Protects RWA/trademark holders
- Simple for RWA use case

**Cons:**
- Disadvantages existing crypto tokens
- May feel unfair to crypto-native projects
- Arbitrary precedence

---

### Option 3: First-Come-First-Served with Collision Flag

Allow any registration, but flag collisions:

```
AAPL (registered by Project X)
  ⚠️ Collides with: Apple Inc (Dow, S&P 500)
```

**Pros:**
- No precedence politics
- Market decides value

**Cons:**
- Potential for confusion
- Fraud/impersonation risk
- Trademark issues

---

### Option 4: Tiered Reservation

Only reserve high-profile symbols (Dow, S&P 500, NASDAQ 100), allow others:

| Tier | Reserved | Count |
|------|----------|-------|
| Tier 1 | Dow Jones | 30 |
| Tier 2 | S&P 500 | 503 |
| Tier 3 | NASDAQ 100 | 101 |
| **Total Reserved** | | **~600** |

Remaining 84,000+ FMP symbols would be first-come-first-served.

**Pros:**
- Protects major brands
- Reduces reservation overhead
- Pragmatic compromise

**Cons:**
- Arbitrary cutoff
- Still ~160 collisions with existing tokens

---

### Option 5: Hybrid Approach

Combine TLDs with tiered reservation:

1. Root namespace reserved for Tier 1-3 RWA (Dow, S&P 500, NASDAQ 100)
2. All other registrations require a TLD
3. RWA TLDs (`.stock`, `.etf`) are admin-controlled
4. Crypto TLDs (`.token`, `.meme`, `.defi`) are open registration

```
AAPL           → Reserved (Apple Inc)
AAPL.stock     → Apple Inc (official RWA)
CAT.meme       → Catcoin meme token
MYTOKEN.defi   → New DeFi project
```

**Pros:**
- Best of both worlds
- Clear hierarchy
- Future-proof

**Cons:**
- Most complex to implement
- Requires TLD governance

---

## Questions for Community

1. **Should RWA symbols take precedence over crypto tokens?**
   - If yes, which tiers? (Dow only? S&P 500? All?)

2. **Do we want TLD-style namespaces?**
   - If yes, which TLDs should exist?
   - Who controls RWA TLDs vs crypto TLDs?

3. **How do we handle existing Solana tokens that collide?**
   - Grandfather them in?
   - Force migration to TLD?
   - Allow both with disambiguation?

4. **What about future tokenized stocks?**
   - Should `AAPL.stock` be reservable by anyone?
   - Or only by verified issuers?

5. **Trademark considerations?**
   - Should TNS enforce trademark protections?
   - Or remain neutral and let legal handle disputes?

## Data Sources

| Source | Status | Count |
|--------|--------|-------|
| Community Token List | Archived April 2025 | 781 |
| Solana Token List | Frozen July 2022 | 13,053 |
| Dow Jones | Live | 30 |
| S&P 500 | Live | 503 |
| S&P 400 | Live | 400 |
| S&P 600 | Live | 603 |
| NASDAQ 100 | Live | 101 |
| FMP Stocks | Live | 85,688 |
| FMP ETFs | Live | 13,489 |

## Next Steps

1. Community discussion on preferred approach
2. Technical feasibility analysis
3. Governance model for TLDs (if applicable)
4. Migration plan for existing tokens
5. Implementation timeline

---

*This RFC is open for community feedback. Please share your thoughts and preferences.*

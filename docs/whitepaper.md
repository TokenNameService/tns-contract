# TNS: Token Naming Service

## The Problem

Solana has shown that the dream of low-latency, low-cost infrastructure comes with a tradeoff: when token creation is inexpensive and symbols are unrestricted, duplicate identifiers proliferate. Thousands of tokens can share the same symbol. Search "BONK" on any Solana DEX and you'll find hundreds of results. Which one is authentic? Users are harmed daily by fraudulent tokens bearing identical symbols.

This is unsustainable. For Solana to mature—for RWAs to come on-chain, for blue-chip institutions to participate—there must be a way to verify token authenticity with certainty.

## The Verification Challenge

Today, aggregators and explorers work hard to verify tokens, but face inherent challenges at scale:

- Manual review processes that can't keep pace with millions of new tokens
- No on-chain source of truth for symbol ownership
- Each platform maintaining separate verification systems

These challenges mean:
1. **Duplicated effort** — Every platform solves the same problem independently
2. **Inconsistent results** — A token verified on one platform may not be on another
3. **Scaling limits** — Human review can't match the pace of token creation
4. **No self-service** — Legitimate projects must wait for external verification

This is not how trust should work on a decentralized network.

## Why Uniqueness Matters

The NYSE and NASDAQ solved this problem decades ago: **one symbol, one security**. You can't list two different stocks as "AAPL." This isn't bureaucracy—it's infrastructure.

When a trader sees AAPL, they know exactly what they're buying. No ambiguity. No scams. The symbol itself carries trust.

Real-world assets coming on-chain need the same trust infrastructure:

- A tokenized share of Apple stock needs to be THE "AAPL" token
- A stablecoin needs to be THE verified issuer
- A real estate token needs provable authenticity

Without symbol uniqueness, RWA adoption remains blocked by verification uncertainty. Solana needs this primitive.

## The Solution: TNS

TNS (Token Naming Service) is a decentralized registry for unique token symbols on Solana.

**Core mechanics:**
- Each symbol (e.g., "BONK") can only be registered once
- Registration creates an on-chain PDA: `["symbol", "BONK"]`
- The PDA stores the verified mint address
- Anyone can verify a token with a single lookup or CPI call

**That's it.** No oracles. No committees. No data science. Just a simple on-chain registry that answers: *"What is THE verified mint for this symbol?"*

## On-Chain Verification

For wallets and applications, verification is trivial:

```rust
// Derive the PDA
let (symbol_pda, _) = Pubkey::find_program_address(
    &[b"symbol", b"BONK"],
    &tns_program_id
);

// Fetch and compare
let symbol_account = Symbol::try_from_slice(&account_data)?;
let is_verified = symbol_account.mint == token_mint;
```

No API calls. No trusted third parties. Just math.

## Pricing Mechanism

TNS mirrors the economics of traditional domain names, but with fixed, immutable rules.

**Registration cost:**
- Base price: ~$10 USD (in SOL), matching .com wholesale at protocol inception (Jan 2026)
- Annual increase: 7%, inspired by ICANN/Verisign pricing models
- Maximum registration: 10 years at a time, inspired by ICANN policy

**Discounts:**
- Multi-year registration: Up to 25% off at 10 years

**Renewal:**
- Symbols must be renewed before expiration
- 90-day grace period after expiration
- After grace period, anyone can call the expiration crank and earn 10% of the original registration fee
- Symbol becomes available for re-registration

Realistically, only dead projects will ever get recycled. If your BONK project never gets off the ground, maybe someone else's will. Someone should have the chance to bring that project to life if it is currently dying on the vine.

**Key difference:** Unlike traditional domain registries, these rules are hardcoded into the smart contract. No renegotiation. No backroom deals. The protocol is governed by code, not committees.

## Launch Strategy

Decentralization is a process, not a starting point. TNS launches with training wheels that are progressively removed until the protocol becomes fully autonomous infrastructure.

**Phase 1: Genesis (Q1 2026)**

Admin-only registration. Working with the DAO to verify the list of existing symbols and seed them for free for 10 years. Verified tokens are claimed by their mint authority through admin. Reserved tradfi symbols (S&P 500, Russell 3000) and non-whitelisted tokens also require admin approval. Projects not on the whitelist can apply for inclusion.

| Symbol Type | Who Can Register |
|-------------|------------------|
| Verified (BONK, SOL, etc.) | Admin only |
| Reserved (AAPL, GOOGL, etc.) | Admin only |
| Not listed | Admin only |

**Phase 2: Open Registration (Q2 2026)**

Non-whitelisted symbols open to anyone. New tokens can register their symbols without admin approval.

Verified tokens remain protected—only mint authorities can claim their symbols. Reserved tradfi symbols remain admin-only, allowing continued onboarding of legitimate RWA issuers before full decentralization.

| Symbol Type | Who Can Register |
|-------------|------------------|
| Verified (BONK, SOL, etc.) | Mint authority only |
| Reserved (AAPL, GOOGL, etc.) | Admin only |
| Not listed | Anyone |

**Phase 3: Full Decentralization (Q3-Q4 2026)**

All restrictions removed. Any symbol—including previously reserved traditional finance tickers—becomes available for registration on a first-come, first-served basis.

| Symbol Type | Who Can Register |
|-------------|------------------|
| All symbols | Anyone |

**Phase 4: Immutability (2027+)**

After a stabilization period, the program upgrade authority is permanently revoked. The rules become immutable—no admin, no governance, no changes possible. TNS becomes pure infrastructure, like TCP/IP.

## Conclusion

Solana doesn't need more data science for token verification. It needs a simple, decentralized registry that makes symbols unique—just like the stock market figured out a century ago and DNS has been doing since its inception.

TNS is that registry.

One symbol. One token. Verifiable by anyone. Governed by no one.

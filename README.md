# TNS - Token Naming Service - Contract

On-chain registry mapping token symbols to verified mints. DNS for Solana token symbols.

**[Whitepaper](./docs/whitepaper.md)**

## Quick Start

```bash
# Build and run all tests
anchor test
```

```bash
# Setup
cd app && npm install

# Register a symbol (5 years, pays SOL via Pyth oracle)
npx tsx demo.ts init
npx tsx demo.ts register BONK DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 5

# Lookup
npx tsx demo.ts lookup BONK
npx tsx demo.ts lookup-mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
npx tsx demo.ts pda BONK

# Manage
npx tsx demo.ts renew BONK 3                        # extend registration
npx tsx demo.ts update-mint BONK <NEW_MINT>          # change associated mint
npx tsx demo.ts transfer BONK <NEW_OWNER>            # transfer ownership
npx tsx demo.ts cancel BONK                          # cancel and reclaim rent
```

## On-Chain Lookup

```typescript
const [symbolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("symbol"), Buffer.from("BONK")],
  TNS_PROGRAM_ID
);
const account = await program.account.symbol.fetch(symbolPda);
// account.mint, account.owner, account.expiresAt
```

---

## Instructions

### Admin

| Instruction | Description |
|-------------|-------------|
| `initialize` | Initialize protocol config |
| `update_config` | Update config parameters (fee collector, phase, paused, keeper reward) |
| `seed_symbol` | Seed verified tokens during genesis (no fee) |
| `admin_update_symbol` | Force-update symbol owner/mint/expiration |
| `admin_close_symbol` | Force-close symbol account |

### Registration (SOL, TNS, USDC, USDT variants)

| Instruction | Description |
|-------------|-------------|
| `register_symbol_*` | Register a new symbol (TNS gets 25% discount) |
| `renew_symbol_*` | Extend registration |
| `claim_expired_symbol_*` | Claim expired symbol past grace period |
| `update_mint_*` | Change associated mint (owner, 50% of base fee) |

### Ownership & Maintenance

| Instruction | Description |
|-------------|-------------|
| `transfer_ownership` | Transfer symbol to new owner |
| `claim_ownership` | Claim via mint/metadata authority or >50% token holdings |
| `cancel_symbol` | Close abandoned symbol 1yr+ past grace (keeper earns rent + reward) |
| `verify_or_close` | Verify metadata match or close drifted symbol (keeper earns rent) |

## Pricing

- Base: $10/year (USD, converted via Pyth SOL/USD oracle)
- Multi-year discounts: 5% (2yr) → 25% (10yr)
- 90-day grace period after expiration
- Fixed 0.05 SOL keeper reward for cranks (cancel/verify)

## Phases

1. **Genesis**: Admin seeds verified tokens; all registrations require admin approval
2. **Open Registration**: Anyone can register, except reserved TradFi symbols (admin only)
3. **Full Decentralization**: All restrictions removed, anyone can register any symbol
4. **Immutability**: Upgrade authority revoked, protocol becomes pure infrastructure

## Reserved Symbols

TradFi symbols are reserved to prevent collisions with future RWA tokenization. Data is fetched from Wikipedia (major indexes) and FMP (full market coverage).

```bash
# Fetch index data only (no API key needed)
pnpm fetch:reserved:indexes

# Fetch all data including FMP (requires API key)
pnpm fetch:reserved

# Regenerate Rust code from JSON data
pnpm generate:reserved
```

**API Key**: FMP data requires a [Financial Modeling Prep](https://financialmodelingprep.com/) API key. Copy `.env.example` to `.env` and add your key.

# TNS - Token Naming Service - Contract

On-chain registry mapping token symbols to verified mints. DNS for Solana token symbols.

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

| Instruction | Description |
|-------------|-------------|
| `initialize` | Initialize protocol config (admin) |
| `update_config` | Update config parameters (admin) |
| `register_symbol` | Register a new symbol |
| `renew_symbol` | Extend registration |
| `expire_symbol` | Crank to expire past grace period |
| `update_mint` | Change associated mint (owner) |
| `transfer_ownership` | Transfer symbol ownership |
| `update_sns_domain` | Link SNS .sol domain |

## Pricing

- Base: $10/year (USD, converted via Pyth SOL/USD oracle)
- Multi-year discounts: 5% (2yr) → 25% (10yr)
- 90-day grace period after expiration
- 10% keeper reward for expire cranks

## Phases

1. **Genesis**: Admin-only registration for all symbol types
2. **Open**: Verified → mint authority, Reserved → admin, Not listed → anyone
3. **Full**: All restrictions removed, anyone can register any symbol

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

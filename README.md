# TNS - Token Naming Service - Contract

On-chain registry mapping token symbols to verified mints. DNS for Solana token symbols.

**[Whitepaper](./docs/whitepaper.md)**

## Quick Start

```bash
# Build and run all tests
anchor test

# Setup demo CLI
cd app && npm install
```

## Demo CLI

All commands run from the `app/` directory.

```bash
cd app && npm install
```

### Setup & Config

```bash
# Initialize config (one-time, starts PAUSED)
npx tsx demo.ts init

# View current config state
npx tsx demo.ts config

# Create fee collector ATAs for USDC/USDT/TNS
npx tsx demo.ts create-atas
```

### Registration & Management

```bash
# Register a symbol (1-10 years, pays with SOL)
npx tsx demo.ts register Bonk DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 5

# Renew a symbol
npx tsx demo.ts renew Bonk 3

# Update mint for a symbol
npx tsx demo.ts update-mint Bonk <NEW_MINT>

# Transfer symbol ownership
npx tsx demo.ts transfer Bonk <NEW_OWNER>

# Cancel and close symbol account
npx tsx demo.ts cancel Bonk

# Verify symbol matches metadata (keeper enforcement)
npx tsx demo.ts verify Bonk
```

### Lookup

```bash
# Lookup symbol details
npx tsx demo.ts lookup Bonk

# Reverse lookup by mint
npx tsx demo.ts lookup-mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263

# Derive token PDA
npx tsx demo.ts pda Bonk
```

### Admin Commands

```bash
# Unpause the protocol
npx tsx demo.ts unpause

# Pause the protocol
npx tsx demo.ts pause

# Set protocol phase (1/2/3)
npx tsx demo.ts set-phase 2

# Seed a symbol (admin only, free, default 2 years)
npx tsx demo.ts seed Bonk DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 <OWNER_PUBKEY> 10

# Force-update a symbol
npx tsx demo.ts admin-update Bonk --owner <NEW_OWNER>
npx tsx demo.ts admin-update Bonk --mint <NEW_MINT>
npx tsx demo.ts admin-update Bonk --expires 1735689600

# Force-close a symbol
npx tsx demo.ts admin-close Bonk
```

## On-Chain Lookup

```typescript
const [symbolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("symbol"), Buffer.from("Bonk")],
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

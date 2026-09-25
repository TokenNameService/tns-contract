# TNS — External Registrations (refund cross-check)

Reconstructed from on-chain transaction history for the 2,610 symbol accounts
closed on 2026-09-25. 2,591 were owned by your own wallets; the 19 below were
owned by outside wallets.

**Only 3 involved money from someone other than you.** The other 16 were
`SeedSymbol` (admin-seeded, free) or were paid for out of your own wallets.

Machine-readable version: `tns-external-registrations.json`

---

## Refund candidates

3 symbols across 2 wallets.

### `2uxsWw7nQseuqG6bxG13mvxJV1CzpLJSdTpasHpQsEE1`

| symbol | registered | instruction | SOL spent | tokens paid | fee to collector | keeper deposit |
|---|---|---|---:|---:|---:|---:|
| OGG | 2026-03-07 00:53 | RegisterSymbolTns | 0.052058 | 31250 TNS | 0.000000 | 0.05 |
| WIPE | 2026-03-07 00:27 | RegisterSymbolTns | 0.052058 | 31250 TNS | 0.000000 | 0.05 |

**Total out of pocket: 0.104116 SOL + 62500 TNS**

- `OGG` tx: `4mMoz5FvGmAG83b4dhnoKH8wGjt7sWaH4Lsm3h3Loz16TN3Gf1FvHEhnNw3ip63MrVGRJjYMKqFCwx4KCEoYi9zg`
- `WIPE` tx: `5ntuHuF5FHuA7wWEBk1mvvXPvxTMqmTciuvtiX6HgFKm7SX3ujBP9n72PWCSt3YQgNHiuRgT5YSezNvyueahYwYt`

### `9AE152n1kHYUK7kMuD8SwwiABYVCGsNc4964BHyLm4Lj`

| symbol | registered | instruction | SOL spent | tokens paid | fee to collector | keeper deposit |
|---|---|---|---:|---:|---:|---:|
| FORMOSA | 2026-03-05 20:38 | RegisterSymbolSol | 0.073650 | — | 0.021517 | 0.05 |

**Total out of pocket: 0.073650 SOL + none**

- `FORMOSA` tx: `4VhTTYrxP8kkhKu1q7X2Q276eY5Msp9XKpbMgX8zyRiHvyzjuo3K1UaA9CiqnYkC5gpPtCymcktLAvXZNAH4LyQ5`

---

## No refund owed

These 16 were owned by outside wallets but **paid for by you**. The owner never
spent anything — `SeedSymbol` is the free admin genesis path, and ROAST was
registered from your own fee-collector wallet.

| symbol | owner | instruction | paid by |
|---|---|---|---|
| fishin | `6gkkRU5t8WfXHWNuc6zQ7FoQxybcigLvzJKLz7Z1tGg` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| AEDX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| AUDX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| CADX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| CHFX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| CNYX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| EURX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| GBPX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| INRX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| JPYX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| KRWX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| MXNX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| SARX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| STABLE | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| USDX | `9TYUScB6w9hG4YACcHsWs93AEA5xQKuQhrC4p1mUGKGA` | SeedSymbol | `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` |
| ROAST | `CRVfosbhMXUgSW6x4AgHmVGG54cWHtTZXKwb7y89YQ5V` | RegisterSymbolUsdc | `TNS1pnrBBe5K7eUpm3bcd4nxnfupVK6EatmoYRfxpMm` |

---

## How to read the columns

- **SOL spent** — total lamports that left the payer's wallet, including the
  0.0020532 rent for the symbol account and the ~0.000005 network fee.
- **fee to collector** — the registration fee proper, paid to `TNS1pnr…`.
- **keeper deposit** — a flat 0.05 SOL per paid registration that went into the
  config PDA to fund keeper rewards. Six such deposits are what made up the
  0.30 SOL later drained during shutdown.
- **tokens paid** — TNS/USDC/USDT paid instead of SOL. TNS payment carried a 25% discount.

A refund at cost would be the SOL spent plus any tokens paid. The rent portion
(0.0020532/symbol) was reclaimed by you when the accounts were closed.


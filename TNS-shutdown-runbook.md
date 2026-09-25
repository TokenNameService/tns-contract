# TNS Shutdown — SOL Recovery Runbook

Recovers **≈34.8 SOL** from the TNS mainnet deployment.

Program: `TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12`
Everything lands in **TNSDbwh…Udrue** (the admin wallet).

---

## The three TNS wallets

| Wallet | Keypair file | Role |
|---|---|---|
| `TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue` | `~/.config/solana/tns.json` | **Config admin.** Seeded genesis; signs every symbol close. Symbol rent lands here automatically — `close = admin` is hardcoded on-chain. Also holds 7,265 USDC. |
| `TNSdmywydQPKU3HJz4Bg7TE7gkeHzyASdw42A3pCENt` | `~/.config/solana/tns-deploy.json` | **Upgrade authority.** Paid for the deploy; the only key that can close the program, the IDL, and the TNS lookup table. |
| `TNS1pnrBBe5K7eUpm3bcd4nxnfupVK6EatmoYRfxpMm` | *(not on this machine)* | Fee collector. 0.016 SOL stranded unless the key turns up. |

Nothing below needs environment variables. `close-genesis.ts` reads the Helius
RPC from `tns-contract/.env` and the admin key from `~/.config/solana/tns.json`
on its own, exactly like `seed-genesis.ts`.

---

## Order matters

`solana program close` (step 5) **permanently orphans every account the program
owns**. Run it before steps 1 and 2 and you burn 5.43 SOL with no recovery path.

Steps 1 and 2 are safe to do on their own — you can stop after them and come back
later. Step 5 is the only one-way door.

---

## Step 0 — Point the CLI at Helius, start the ALT cooldown

The `solana` CLI doesn't read `.env`, so point it at Helius once. This keeps the
API key out of this file:

```bash
solana config set --url "$(grep '^SOLANA_RPC_URL=' ~/Desktop/personal/Thyngify/tns-repos/tns-contract/.env | cut -d= -f2-)"
```

To undo later: `solana config set --url https://api.mainnet-beta.solana.com`

Lookup tables need ~4 minutes between deactivate and close, so start that now and
it'll be ready by the time step 1 finishes.

```bash
solana address-lookup-table deactivate EKa1ymcJhuR6QYkU5y2c93GxsqZyfGFgtoLikfQmsqfW \
  --authority ~/.config/solana/tns-deploy.json \
  -k ~/.config/solana/tns-deploy.json --bypass-warning
```

That's the only lookup table TNS owns.

---

## Step 1 — Symbol accounts + config drain → 5.61 SOL

```bash
cd ~/Desktop/personal/Thyngify/tns-repos/tns-contract

npx tsx scripts/close-genesis.ts             # dry run — read the output first
npx tsx scripts/close-genesis.ts --execute   # ~25 min, 143 transactions
```

Or `pnpm close:genesis` / `pnpm close:genesis --execute`.

Add `--skip-external` if you want to leave the 20 outside-owned symbols alone.
See "The 20 outside symbols" below before deciding.

What `--execute` does, in order:

1. **Drains the config PDA** (0.25 SOL) — five `admin_update_symbol` +
   `cancel_symbol` pairs. This only works while symbols still exist, which is why
   it runs first. Once the registry is empty the float is stranded forever.
2. **Closes the remaining ~2,605 symbols** in batches of 19, checkpointing to
   `scripts/data/close-record.json` after every batch.

**If it dies partway**, just re-run the same command. It re-reads on-chain state
and the drain detects it's already done. For individual stragglers:

```bash
npx tsx scripts/close-genesis.ts --execute --retry
```

**Verify before moving on** — this must report 0:

```bash
npx tsx scripts/close-genesis.ts | grep "Found"
```

---

## Step 2 — IDL account → 0.07 SOL

```bash
cd ~/Desktop/personal/Thyngify/tns-repos/tns-contract

anchor idl close TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12 \
  --provider.wallet ~/.config/solana/tns-deploy.json
```

---

## Step 3 — Close the TNS lookup table → 0.004 SOL

Needs ~4 minutes to have passed since step 0.

```bash
solana address-lookup-table close EKa1ymcJhuR6QYkU5y2c93GxsqZyfGFgtoLikfQmsqfW \
  --authority ~/.config/solana/tns-deploy.json \
  --recipient TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue \
  -k ~/.config/solana/tns-deploy.json
```

If it errors with "not deactivated yet", wait a minute and re-run.

---

## Step 4 — Empty token accounts → 0.004 SOL

Only these two are actually empty and closable:

```bash
spl-token close --address Ap9xvGN28VgPhU1MJdcG2dNXMJLLFhRKoWR28EAX1it2 \
  --owner ~/.config/solana/tns.json --fee-payer ~/.config/solana/tns.json

spl-token close --address 5pJTL85hKv5QitfeWwgx2UP5FBMobn78aXbryTVFMaoC \
  --owner ~/.config/solana/tns.json --fee-payer ~/.config/solana/tns.json
```

Your company and personal wallets hold ~44 more empty ATAs (~0.10 SOL), but those
are unrelated to TNS — general wallet cleanup, do it whenever.

---

## Step 5 — Close the program → 28.51 SOL ⚠️ POINT OF NO RETURN

**Only after step 1 reports 0 symbols and step 2 succeeded.**

```bash
solana program close TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12 \
  --authority ~/.config/solana/tns-deploy.json \
  --recipient TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue \
  -k ~/.config/solana/tns-deploy.json \
  --bypass-warning
```

---

## Step 6 — Sweep the deploy wallet → 0.02 SOL

Everything else already lands in TNSDbwh. This just empties the upgrade authority.

```bash
solana transfer TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue ALL \
  --from ~/.config/solana/tns-deploy.json \
  --fee-payer ~/.config/solana/tns-deploy.json \
  --allow-unfunded-recipient
```

Final balance check:

```bash
solana balance TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue
spl-token accounts --owner TNSDbwhVo6deZrgH3ZYZriixupMadBoHJTViAoUdrue
```

---

## Totals

| Step | What | SOL |
|---|---|---:|
| 1 | 2,610 symbol PDAs + config drain | 5.6082 |
| 2 | Anchor IDL account | 0.0696 |
| 3 | TNS address lookup table | 0.0042 |
| 4 | 2 empty token accounts | 0.0041 |
| 5 | Program data account (4 MB) | 28.5134 |
| 6 | Deploy wallet sweep | ~0.0199 |
| | **Total** | **≈ 34.22** |

Transaction fees across the whole thing are ~0.001 SOL.

Plus **0.60 SOL** from the company-wallet lookup tables, if you decide those are
dead — see `~/Desktop/company-alt-cleanup.sh`. That's tracked separately because
it has nothing to do with TNS.

---

## Three things to know

**The 20 outside symbols.** 2,590 of the 2,610 are yours. 20 belong to six other
wallets — one holds 14 forex-style tickers (`EURX`, `JPYX`, `USDX`…), five hold one
or two each. Their rent totals 0.0411 SOL. `--skip-external` leaves them open, but
that doesn't protect them: step 5 orphans them either way and their owners lose the
rent instead of you recovering it. The real choice is "close them and refund the six
wallets ~$8" or "close them and don't." Leaving them open helps nobody.

**0.053 SOL stays in the config PDA permanently.** The drain stops at the on-chain
guard (`balance > min_rent + reward`, strict comparison), leaving one reward plus
rent behind. Extracting it would mean a 4 MB redeploy to add a close instruction.
Not worth it.

**Back up `~/.config/solana/tns.json`.** After this runbook it holds ~34.8 SOL *and*
7,265 USDC, and it's the only key to both. The USDC is untouched by every step
above — it sits in a normal ATA that has nothing to do with the TNS program.

The fee-collector key (`TNS1pnr…`) is not on this machine — checked `~/.config/solana`
and all the repos. If it's in a password manager, sweep it too: 0.0099 SOL plus
three empty ATAs at 0.0062 SOL.

/**
 * Close Genesis - Reclaim rent from every TNS symbol account
 *
 * The inverse of seed-genesis.ts. Discovers live symbol accounts on-chain and
 * closes them via admin_close_symbol, returning rent to the admin.
 *
 * Unlike seed-genesis, this defaults to a dry run - closing is irreversible and
 * there is no way to recreate an account once the program itself is closed.
 *
 * Usage:
 *   npx tsx scripts/close-genesis.ts                      # Dry run - report only
 *   npx tsx scripts/close-genesis.ts --execute            # Actually close
 *   npx tsx scripts/close-genesis.ts --skip-external      # Leave non-admin-owned symbols alone
 *   npx tsx scripts/close-genesis.ts --no-drain           # Skip the config keeper-reward drain
 *   npx tsx scripts/close-genesis.ts --batch=10           # Set batch size (max 19)
 *   npx tsx scripts/close-genesis.ts --continue=BONK      # Resume from a specific symbol
 *   npx tsx scripts/close-genesis.ts --retry              # Retry failures from close-failures.json
 *   npx tsx scripts/close-genesis.ts --priority-fee=1000  # microLamports per CU (default 1000)
 *
 * Run this to completion BEFORE `solana program close`. Closing the program
 * orphans every account it owns - their rent becomes permanently unrecoverable.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const BATCH_SIZE = 19; // 19 closes serializes to 1188 bytes; 20 is 1234, over the 1232 cap
const MAX_BATCH_SIZE = 19;
const BATCH_DELAY_MS = 2000; // Delay between batches to avoid rate limiting
const COMPUTE_UNIT_LIMIT = 350_000;
const PRIORITY_FEE_MICRO_LAMPORTS = 1000;
const TOKEN_ACCOUNT_SIZE = 167;
// cancel_symbol pays this out of the config PDA, guarded by
// `config_balance > min_rent + keeper_reward`. Mirrors the on-chain constants.
const KEEPER_REWARD_LAMPORTS = 50_000_000;
const CONFIG_MIN_RENT_LAMPORTS = 2_951_040; // rent-exempt for 8 + Config::INIT_SPACE
const RPC_URL =
  process.env.SOLANA_RPC_URL || process.env.RPC_URL || "http://localhost:8899";
const ADMIN_KEYPAIR_PATH =
  process.env.ADMIN_KEYPAIR || join(homedir(), ".config", "solana", "tns.json");
const PROGRAM_ID = new PublicKey("TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12");

interface LiveSymbol {
  symbol: string;
  mint: string;
  owner: string;
  pda: string;
  lamports: number;
}

interface CloseResult {
  symbol: string;
  pda: string;
  status: "closed" | "failed" | "skipped";
  lamports?: number;
  txSignature?: string;
  reason?: string;
}

interface CloseRecord {
  closedAt: string;
  network: string;
  programId: string;
  admin: string;
  totalAttempted: number;
  totalClosed: number;
  totalSkipped: number;
  totalFailed: number;
  lamportsRecovered: number;
  symbols: CloseResult[];
}

function getConfigPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  return pda;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sol(lamports: number): string {
  return (lamports / 1e9).toFixed(9);
}

/**
 * Fetch every live symbol account. Deliberately reads on-chain state rather
 * than genesis-record.json - registrations, transfers and expirations have
 * happened since seeding, and the record is a snapshot of intent, not truth.
 */
async function fetchLiveSymbols(
  connection: Connection,
  program: Program
): Promise<LiveSymbol[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }],
  });

  return accounts
    .map(({ pubkey, account }) => {
      const decoded = program.coder.accounts.decode("token", account.data);
      return {
        symbol: decoded.symbol as string,
        mint: decoded.mint.toBase58(),
        owner: decoded.owner.toBase58(),
        pda: pubkey.toBase58(),
        lamports: account.lamports,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function buildCloseIx(
  program: Program,
  admin: PublicKey,
  configPda: PublicKey,
  tokenPda: PublicKey
) {
  return (program.methods as any)
    .adminCloseSymbol()
    .accounts({
      admin,
      config: configPda,
      tokenAccount: tokenPda,
    })
    .instruction();
}

/**
 * Drain the keeper-reward float from the config PDA.
 *
 * There is no close_config instruction, so the only way to get these lamports
 * out is cancel_symbol, which pays a 0.05 SOL keeper reward from config and is
 * gated on the symbol being 455+ days past expiry. admin_update_symbol accepts
 * an arbitrary expires_at, so we backdate a symbol and immediately cancel it.
 *
 * This consumes one symbol per 0.05 SOL and must run while symbols still exist -
 * once the registry is empty the float is stranded for good.
 */
async function drainConfig(
  program: Program,
  provider: anchor.AnchorProvider,
  admin: Keypair,
  configPda: PublicKey,
  candidates: LiveSymbol[],
  priorityFee: number
): Promise<{ used: LiveSymbol[]; lamports: number }> {
  const balance = await provider.connection.getBalance(configPda);
  const floor = CONFIG_MIN_RENT_LAMPORTS + KEEPER_REWARD_LAMPORTS;

  const rounds = Math.max(
    0,
    Math.ceil((balance - floor) / KEEPER_REWARD_LAMPORTS)
  );
  console.log(`Config balance: ${sol(balance)} SOL`);

  if (rounds === 0) {
    console.log("Config is at its rent floor - nothing to drain.");
    return { used: [], lamports: 0 };
  }
  if (rounds > candidates.length) {
    throw new Error(
      `Need ${rounds} symbols to drain config but only ${candidates.length} available`
    );
  }

  console.log(
    `Draining ${sol(rounds * KEEPER_REWARD_LAMPORTS)} SOL over ${rounds} ` +
      `cancel_symbol calls (${sol(CONFIG_MIN_RENT_LAMPORTS)} SOL stays as rent)`
  );

  const used: LiveSymbol[] = [];
  let recovered = 0;

  for (let i = 0; i < rounds; i++) {
    const target = candidates[i];
    const tokenPda = new PublicKey(target.pda);

    const tx = new Transaction().add(...budgetIxs(priorityFee));
    tx.add(
      await (program.methods as any)
        .adminUpdateSymbol(null, null, new anchor.BN(0))
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
        })
        .instruction()
    );
    tx.add(
      await (program.methods as any)
        .cancelSymbol()
        .accounts({
          keeper: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
        })
        .instruction()
    );

    const sig = await provider.sendAndConfirm(tx);
    console.log(
      `  ${i + 1}/${rounds} ${target.symbol}: backdated + canceled (${sig})`
    );
    used.push(target);
    recovered += KEEPER_REWARD_LAMPORTS + target.lamports;
  }

  const after = await provider.connection.getBalance(configPda);
  console.log(`Config balance now: ${sol(after)} SOL`);
  return { used, lamports: recovered };
}

function budgetIxs(priorityFee: number) {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
  ];
  if (priorityFee > 0) {
    ixs.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
    );
  }
  return ixs;
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const skipExternal = args.includes("--skip-external");
  const noDrain = args.includes("--no-drain");
  const retryMode = args.includes("--retry");
  const continueFrom = args
    .find((a) => a.startsWith("--continue="))
    ?.split("=")[1];
  const batchSizeArg = args
    .find((a) => a.startsWith("--batch="))
    ?.split("=")[1];
  const priorityFeeArg = args
    .find((a) => a.startsWith("--priority-fee="))
    ?.split("=")[1];

  const batchSize = Math.min(
    batchSizeArg ? parseInt(batchSizeArg, 10) : BATCH_SIZE,
    MAX_BATCH_SIZE
  );
  const priorityFee = priorityFeeArg
    ? parseInt(priorityFeeArg, 10)
    : PRIORITY_FEE_MICRO_LAMPORTS;

  console.log("=".repeat(60));
  console.log("TNS Genesis Teardown");
  console.log("=".repeat(60));
  console.log(`RPC: ${RPC_URL}`);

  if (!existsSync(ADMIN_KEYPAIR_PATH)) {
    console.error(`Error: Admin keypair not found at ${ADMIN_KEYPAIR_PATH}`);
    console.error("Set ADMIN_KEYPAIR env var to the config admin's keypair.");
    process.exit(1);
  }
  const adminKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(ADMIN_KEYPAIR_PATH, "utf-8")))
  );
  console.log(`Admin: ${adminKeypair.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idlPath = join(__dirname, "..", "target", "idl", "tns.json");
  if (!existsSync(idlPath)) {
    console.error("Error: IDL not found. Run anchor build first.");
    process.exit(1);
  }
  const idl = JSON.parse(readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  const configPda = getConfigPda(PROGRAM_ID);
  console.log(`Config PDA: ${configPda.toBase58()}`);

  // admin_close_symbol has_one's the admin against config - fail here rather
  // than 2610 times with an opaque constraint error.
  const config = await (program.account as any).config.fetch(configPda);
  const onChainAdmin = config.admin.toBase58();
  if (onChainAdmin !== adminKeypair.publicKey.toBase58()) {
    console.error(`Error: keypair is not the config admin.`);
    console.error(`  config.admin: ${onChainAdmin}`);
    console.error(`  keypair:      ${adminKeypair.publicKey.toBase58()}`);
    process.exit(1);
  }

  console.log("");
  console.log("Fetching live symbol accounts...");
  const live = await fetchLiveSymbols(connection, program);
  console.log(`Found ${live.length} symbol accounts`);

  const external = live.filter(
    (s) => s.owner !== adminKeypair.publicKey.toBase58()
  );
  if (external.length > 0) {
    const externalLamports = external.reduce((n, s) => n + s.lamports, 0);
    const owners = [...new Set(external.map((s) => s.owner))];
    console.log("");
    console.log(
      `${external.length} symbols are owned by ${owners.length} outside wallets ` +
        `(${sol(externalLamports)} SOL of their rent):`
    );
    for (const owner of owners) {
      const theirs = external.filter((s) => s.owner === owner);
      console.log(
        `  ${owner}  ${theirs.length}  ${theirs
          .map((s) => s.symbol)
          .join(", ")}`
      );
    }
    console.log(
      skipExternal
        ? "  --skip-external set: leaving these open."
        : "  These will be closed. Pass --skip-external to leave them."
    );
    console.log(
      "  Note: any symbol left open is orphaned by `solana program close`."
    );
  }

  let targets = skipExternal
    ? live.filter((s) => s.owner === adminKeypair.publicKey.toBase58())
    : live;

  if (retryMode) {
    const failuresPath = join(__dirname, "data", "close-failures.json");
    if (!existsSync(failuresPath)) {
      console.error("Error: close-failures.json not found. Nothing to retry.");
      process.exit(1);
    }
    const failures = JSON.parse(readFileSync(failuresPath, "utf-8"));
    const failedSymbols = new Set<string>(
      failures.symbols.map((s: CloseResult) => s.symbol)
    );
    targets = targets.filter((s) => failedSymbols.has(s.symbol));
    console.log("");
    console.log(`Retry mode: ${targets.length} previously-failed symbols still live`);
  }

  if (continueFrom) {
    const idx = targets.findIndex((s) => s.symbol === continueFrom);
    if (idx >= 0) {
      targets = targets.slice(idx);
      console.log(`Continuing from ${continueFrom} (index ${idx})`);
    } else {
      console.log(`${continueFrom} not found among live symbols - closed already?`);
    }
  }

  const configBalance = await connection.getBalance(configPda);
  const drainable = noDrain
    ? 0
    : Math.max(
        0,
        Math.ceil(
          (configBalance - CONFIG_MIN_RENT_LAMPORTS - KEEPER_REWARD_LAMPORTS) /
            KEEPER_REWARD_LAMPORTS
        )
      ) * KEEPER_REWARD_LAMPORTS;

  const recoverable = targets.reduce((n, s) => n + s.lamports, 0);
  const estimatedFees = Math.ceil(targets.length / batchSize) * 5000;

  console.log("");
  console.log(`To close:    ${targets.length} accounts`);
  console.log(`Rent:        ${sol(recoverable)} SOL`);
  console.log(`Config drain:${sol(drainable)} SOL${noDrain ? " (--no-drain: skipped)" : ""}`);
  console.log(`Batches:     ~${Math.ceil(targets.length / batchSize)} txs @ ${batchSize} per tx`);
  console.log(`Est. fees:   ~${sol(estimatedFees)} SOL`);
  console.log(`Net:         ~${sol(recoverable + drainable - estimatedFees)} SOL`);

  if (!execute) {
    const previewPath = join(__dirname, "data", "close-preview.json");
    writeFileSync(
      previewPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          programId: PROGRAM_ID.toBase58(),
          admin: adminKeypair.publicKey.toBase58(),
          totalLive: live.length,
          totalTargeted: targets.length,
          lamportsRecoverable: recoverable,
          external,
          targets,
        },
        null,
        2
      )
    );
    console.log("");
    console.log(`Dry run. Preview written to ${previewPath}`);
    console.log("Re-run with --execute to close these accounts.");
    return;
  }

  if (targets.length === 0) {
    console.log("");
    console.log("Nothing to close.");
    return;
  }

  const results: CloseRecord = {
    closedAt: new Date().toISOString(),
    network: RPC_URL.includes("mainnet")
      ? "mainnet-beta"
      : RPC_URL.includes("devnet")
      ? "devnet"
      : "localnet",
    programId: PROGRAM_ID.toBase58(),
    admin: adminKeypair.publicKey.toBase58(),
    totalAttempted: targets.length,
    totalClosed: 0,
    totalSkipped: 0,
    totalFailed: 0,
    lamportsRecovered: 0,
    symbols: [],
  };

  const recordPath = join(__dirname, "data", "close-record.json");
  const failuresPath = join(__dirname, "data", "close-failures.json");

  // Drain first: cancel_symbol needs live symbols, so this is impossible once
  // the bulk close finishes. Only admin-owned symbols are eligible.
  if (!noDrain) {
    console.log("");
    console.log("--- Draining config keeper-reward float ---");
    const adminOwned = targets.filter(
      (s) => s.owner === adminKeypair.publicKey.toBase58()
    );
    const drained = await drainConfig(
      program,
      provider,
      adminKeypair,
      configPda,
      adminOwned,
      priorityFee
    );
    for (const s of drained.used) {
      results.symbols.push({
        symbol: s.symbol,
        pda: s.pda,
        status: "closed",
        lamports: s.lamports,
        reason: "canceled to drain config",
      });
      results.totalClosed++;
    }
    results.lamportsRecovered += drained.lamports;
    const usedPdas = new Set(drained.used.map((s) => s.pda));
    targets = targets.filter((s) => !usedPdas.has(s.pda));
  }

  const batches = chunk(targets, batchSize);

  console.log("");
  console.log(`Closing ${targets.length} accounts in ${batches.length} batches...`);
  console.log("");

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const label = `Batch ${i + 1}/${batches.length}`;

    try {
      const tx = new Transaction().add(...budgetIxs(priorityFee));
      for (const { pda } of batch) {
        tx.add(
          await buildCloseIx(
            program,
            adminKeypair.publicKey,
            configPda,
            new PublicKey(pda)
          )
        );
      }

      const sig = await provider.sendAndConfirm(tx);
      console.log(`${label}: closed ${batch.length} (${sig})`);

      for (const s of batch) {
        results.symbols.push({
          symbol: s.symbol,
          pda: s.pda,
          status: "closed",
          lamports: s.lamports,
          txSignature: sig,
        });
        results.totalClosed++;
        results.lamportsRecovered += s.lamports;
      }
    } catch (error: any) {
      console.error(`${label}: failed - ${error.message}`);

      // A batch fails as a unit, so some of these may have landed on a previous
      // attempt whose confirmation timed out. Re-check before retrying, or the
      // AccountNotInitialized error will mask the real failure.
      const infos = await connection.getMultipleAccountsInfo(
        batch.map((s) => new PublicKey(s.pda))
      );

      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        if (infos[j] === null) {
          console.log(`  ${s.symbol}: already closed`);
          results.symbols.push({
            symbol: s.symbol,
            pda: s.pda,
            status: "closed",
            lamports: s.lamports,
          });
          results.totalClosed++;
          results.lamportsRecovered += s.lamports;
          continue;
        }

        try {
          const tx = new Transaction()
            .add(...budgetIxs(priorityFee))
            .add(
              await buildCloseIx(
                program,
                adminKeypair.publicKey,
                configPda,
                new PublicKey(s.pda)
              )
            );
          const sig = await provider.sendAndConfirm(tx);
          console.log(`  ${s.symbol}: closed (${sig})`);
          results.symbols.push({
            symbol: s.symbol,
            pda: s.pda,
            status: "closed",
            lamports: s.lamports,
            txSignature: sig,
          });
          results.totalClosed++;
          results.lamportsRecovered += s.lamports;
        } catch (innerError: any) {
          console.error(`  ${s.symbol}: failed - ${innerError.message}`);
          results.symbols.push({
            symbol: s.symbol,
            pda: s.pda,
            status: "failed",
            reason: innerError.message,
          });
          results.totalFailed++;
        }
      }
    }

    // Checkpoint every batch - 130 txs against public RPC will get interrupted,
    // and --continue needs somewhere to resume from.
    writeFileSync(recordPath, JSON.stringify(results, null, 2));

    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  const failed = results.symbols.filter((s) => s.status === "failed");
  writeFileSync(
    failuresPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), symbols: failed },
      null,
      2
    )
  );

  console.log("");
  console.log("=".repeat(60));
  console.log("Genesis Teardown Complete");
  console.log("=".repeat(60));
  console.log(`Total attempted:  ${results.totalAttempted}`);
  console.log(`Total closed:     ${results.totalClosed}`);
  console.log(`Total failed:     ${results.totalFailed}`);
  console.log(`Rent recovered:   ${sol(results.lamportsRecovered)} SOL`);
  console.log(`Record:           ${recordPath}`);

  if (failed.length > 0) {
    console.log("");
    console.log(`${failed.length} failures written to ${failuresPath}`);
    console.log("Re-run with --retry to attempt them again.");
  }

  const stillLive = await fetchLiveSymbols(connection, program);
  console.log("");
  console.log(`Symbol accounts remaining on-chain: ${stillLive.length}`);
  if (stillLive.length > 0) {
    console.log(
      "Do NOT run `solana program close` yet - remaining accounts would be orphaned."
    );
  } else {
    console.log("Registry is empty. Safe to close the IDL account and program.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Seed Genesis - Populate TNS with Jupiter verified tokens
 *
 * This script seeds the TNS registry with verified tokens from Jupiter.
 * It skips any tokens whose symbols collide with reserved TradFi symbols.
 *
 * Usage:
 *   npx tsx scripts/seed-genesis.ts --dry-run       # Preview what would be seeded
 *   npx tsx scripts/seed-genesis.ts                 # Actually seed (requires admin keypair)
 *   npx tsx scripts/seed-genesis.ts --batch=11      # Test max batch size
 *   npx tsx scripts/seed-genesis.ts --continue=BONK # Resume from specific symbol
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const BATCH_SIZE = 10; // Max ~11 based on tx size limit, using 10 for safety
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
const ADMIN_KEYPAIR_PATH =
  process.env.ADMIN_KEYPAIR || join(__dirname, "..", "admin-keypair.json");
const PROGRAM_ID = new PublicKey("TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12");

interface VerifiedTokensFile {
  source: string;
  fetchedAt: string;
  count: number;
  tokens: Record<string, string>;
}

interface TradFiSymbolsFile {
  symbols: string[];
}

interface GenesisRecord {
  seededAt: string;
  network: string;
  programId: string;
  totalAttempted: number;
  totalSeeded: number;
  totalSkipped: number;
  totalFailed: number;
  tokens: Array<{
    symbol: string;
    mint: string;
    status: "seeded" | "skipped" | "failed";
    reason?: string;
    txSignature?: string;
  }>;
}

function getTokenPda(symbol: string, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token"), Buffer.from(symbol.toUpperCase())],
    programId
  );
  return pda;
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

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const continueFrom = args
    .find((a) => a.startsWith("--continue="))
    ?.split("=")[1];
  const batchSizeArg = args
    .find((a) => a.startsWith("--batch="))
    ?.split("=")[1];
  const batchSize = batchSizeArg ? parseInt(batchSizeArg) : BATCH_SIZE;

  console.log("=".repeat(60));
  console.log("TNS Genesis Seeding Script");
  console.log("=".repeat(60));
  console.log(`Mode: ${dryRun ? "DRY RUN (no transactions)" : "LIVE"}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log("");

  // Load verified tokens
  const verifiedPath = join(__dirname, "data", "verified-tokens.json");
  if (!existsSync(verifiedPath)) {
    console.error(
      "Error: verified-tokens.json not found. Run fetch-jupiter-tokens.ts first."
    );
    process.exit(1);
  }
  const verifiedData: VerifiedTokensFile = JSON.parse(
    readFileSync(verifiedPath, "utf-8")
  );
  console.log(
    `Loaded ${verifiedData.count} verified tokens from ${verifiedData.source}`
  );

  // Load TradFi reserved symbols
  const tradfiPath = join(__dirname, "data", "tradfi-symbols.json");
  let reservedSymbols = new Set<string>();
  if (existsSync(tradfiPath)) {
    const tradfiData: TradFiSymbolsFile = JSON.parse(
      readFileSync(tradfiPath, "utf-8")
    );
    reservedSymbols = new Set(tradfiData.symbols.map((s) => s.toUpperCase()));
    console.log(`Loaded ${reservedSymbols.size} reserved TradFi symbols`);
  } else {
    console.log(
      "Warning: tradfi-symbols.json not found, no symbols will be filtered"
    );
  }

  // Filter tokens
  const tokensToSeed: Array<{ symbol: string; mint: string }> = [];
  const skippedTokens: Array<{ symbol: string; mint: string; reason: string }> =
    [];

  for (const [symbol, mint] of Object.entries(verifiedData.tokens)) {
    const upperSymbol = symbol.toUpperCase();

    // Skip if reserved TradFi symbol
    if (reservedSymbols.has(upperSymbol)) {
      skippedTokens.push({
        symbol: upperSymbol,
        mint,
        reason: "Reserved TradFi symbol",
      });
      continue;
    }

    // Skip if symbol too long
    if (upperSymbol.length > 10) {
      skippedTokens.push({
        symbol: upperSymbol,
        mint,
        reason: "Symbol too long (>10 chars)",
      });
      continue;
    }

    // Skip if symbol has invalid characters
    if (!/^[A-Z0-9]+$/.test(upperSymbol)) {
      skippedTokens.push({
        symbol: upperSymbol,
        mint,
        reason: "Invalid characters",
      });
      continue;
    }

    tokensToSeed.push({ symbol: upperSymbol, mint });
  }

  console.log("");
  console.log(`Tokens to seed: ${tokensToSeed.length}`);
  console.log(`Tokens skipped: ${skippedTokens.length}`);

  if (skippedTokens.length > 0) {
    console.log("");
    console.log("Skipped tokens:");
    for (const { symbol, reason } of skippedTokens.slice(0, 10)) {
      console.log(`  ${symbol}: ${reason}`);
    }
    if (skippedTokens.length > 10) {
      console.log(`  ... and ${skippedTokens.length - 10} more`);
    }
  }

  if (dryRun) {
    console.log("");
    console.log("DRY RUN - No transactions will be sent");
    console.log("");
    console.log("Tokens that would be seeded:");
    for (const { symbol, mint } of tokensToSeed.slice(0, 20)) {
      const pda = getTokenPda(symbol, PROGRAM_ID);
      console.log(
        `  ${symbol.padEnd(10)} -> ${mint.slice(0, 8)}... (PDA: ${pda
          .toBase58()
          .slice(0, 8)}...)`
      );
    }
    if (tokensToSeed.length > 20) {
      console.log(`  ... and ${tokensToSeed.length - 20} more`);
    }

    // Write preview record
    const record: GenesisRecord = {
      seededAt: new Date().toISOString(),
      network: "dry-run",
      programId: PROGRAM_ID.toBase58(),
      totalAttempted: tokensToSeed.length,
      totalSeeded: 0,
      totalSkipped: skippedTokens.length,
      totalFailed: 0,
      tokens: [
        ...tokensToSeed.map((t) => ({
          symbol: t.symbol,
          mint: t.mint,
          status: "seeded" as const,
        })),
        ...skippedTokens.map((t) => ({
          symbol: t.symbol,
          mint: t.mint,
          status: "skipped" as const,
          reason: t.reason,
        })),
      ],
    };
    const recordPath = join(__dirname, "data", "genesis-preview.json");
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    console.log("");
    console.log(`Preview written to ${recordPath}`);
    return;
  }

  // Load admin keypair
  if (!existsSync(ADMIN_KEYPAIR_PATH)) {
    console.error(`Error: Admin keypair not found at ${ADMIN_KEYPAIR_PATH}`);
    console.error("Set ADMIN_KEYPAIR env var or create admin-keypair.json");
    process.exit(1);
  }
  const adminKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(ADMIN_KEYPAIR_PATH, "utf-8")))
  );
  console.log(`Admin: ${adminKeypair.publicKey.toBase58()}`);

  // Connect
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Load IDL
  const idlPath = join(__dirname, "..", "target", "idl", "tns.json");
  if (!existsSync(idlPath)) {
    console.error("Error: IDL not found. Run anchor build first.");
    process.exit(1);
  }
  const idl = JSON.parse(readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  const configPda = getConfigPda(PROGRAM_ID);
  console.log(`Config PDA: ${configPda.toBase58()}`);

  // Track results
  const results: GenesisRecord = {
    seededAt: new Date().toISOString(),
    network: RPC_URL.includes("mainnet")
      ? "mainnet-beta"
      : RPC_URL.includes("devnet")
      ? "devnet"
      : "localnet",
    programId: PROGRAM_ID.toBase58(),
    totalAttempted: tokensToSeed.length,
    totalSeeded: 0,
    totalSkipped: skippedTokens.length,
    totalFailed: 0,
    tokens: skippedTokens.map((t) => ({
      symbol: t.symbol,
      mint: t.mint,
      status: "skipped" as const,
      reason: t.reason,
    })),
  };

  // Continue from specific symbol if specified
  let startIndex = 0;
  if (continueFrom) {
    const idx = tokensToSeed.findIndex(
      (t) => t.symbol === continueFrom.toUpperCase()
    );
    if (idx >= 0) {
      startIndex = idx;
      console.log(`Continuing from ${continueFrom} (index ${idx})`);
    }
  }

  const remaining = tokensToSeed.slice(startIndex);
  const batches = chunk(remaining, batchSize);
  console.log(`Batch size: ${batchSize} (max ~11 based on tx size limit)`);

  console.log("");
  console.log(
    `Processing ${remaining.length} tokens in ${batches.length} batches...`
  );
  console.log("");

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(
      `Batch ${i + 1}/${batches.length}: ${batch
        .map((t) => t.symbol)
        .join(", ")}`
    );

    try {
      const tx = new Transaction();

      for (const { symbol, mint } of batch) {
        const tokenPda = getTokenPda(symbol, PROGRAM_ID);
        const mintPubkey = new PublicKey(mint);

        const ix = await (program.methods as any)
          .seedSymbol(symbol, 10) // 10 years default for genesis seeding
          .accounts({
            admin: adminKeypair.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: mintPubkey,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

        tx.add(ix);
      }

      const sig = await provider.sendAndConfirm(tx);
      console.log(`  Success: ${sig}`);

      for (const { symbol, mint } of batch) {
        results.tokens.push({
          symbol,
          mint,
          status: "seeded",
          txSignature: sig,
        });
        results.totalSeeded++;
      }
    } catch (error: any) {
      console.error(`  Failed: ${error.message}`);

      // Try each one individually to find which failed
      for (const { symbol, mint } of batch) {
        try {
          const tokenPda = getTokenPda(symbol, PROGRAM_ID);
          const mintPubkey = new PublicKey(mint);

          const sig = await (program.methods as any)
            .seedSymbol(symbol, 10) // 10 years default for genesis seeding
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              tokenAccount: tokenPda,
              tokenMint: mintPubkey,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          console.log(`    ${symbol}: Success (${sig})`);
          results.tokens.push({
            symbol,
            mint,
            status: "seeded",
            txSignature: sig,
          });
          results.totalSeeded++;
        } catch (innerError: any) {
          console.error(`    ${symbol}: Failed - ${innerError.message}`);
          results.tokens.push({
            symbol,
            mint,
            status: "failed",
            reason: innerError.message,
          });
          results.totalFailed++;
        }
      }
    }

    // Small delay between batches
    await new Promise((r) => setTimeout(r, 500));
  }

  // Write results
  const recordPath = join(__dirname, "data", "genesis-record.json");
  writeFileSync(recordPath, JSON.stringify(results, null, 2));

  console.log("");
  console.log("=".repeat(60));
  console.log("Genesis Seeding Complete");
  console.log("=".repeat(60));
  console.log(`Total attempted: ${results.totalAttempted}`);
  console.log(`Total seeded:    ${results.totalSeeded}`);
  console.log(`Total skipped:   ${results.totalSkipped}`);
  console.log(`Total failed:    ${results.totalFailed}`);
  console.log("");
  console.log(`Results written to ${recordPath}`);
}

main().catch(console.error);

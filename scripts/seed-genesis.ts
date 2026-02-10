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

// Token Metadata Program ID (Metaplex)
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

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
    [Buffer.from("token"), Buffer.from(symbol)],
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

function getMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

/**
 * Fetch the update_authority from a mint's metadata account.
 * Returns null if metadata doesn't exist or can't be parsed.
 */
async function getUpdateAuthority(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey | null> {
  try {
    const metadataPda = getMetadataPda(mint);
    const accountInfo = await connection.getAccountInfo(metadataPda);
    if (!accountInfo) return null;

    // Metadata account structure:
    // - key: u8 (offset 0)
    // - update_authority: Pubkey (offset 1, 32 bytes)
    const data = accountInfo.data;
    if (data.length < 33) return null;

    const updateAuthority = new PublicKey(data.slice(1, 33));
    return updateAuthority;
  } catch {
    return null;
  }
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
  const verifiedPath = join(__dirname, "data", "verified", "verified-tokens.json");
  if (!existsSync(verifiedPath)) {
    console.error(
      "Error: verified-tokens.json not found. Run: npm run fetch:tokens"
    );
    process.exit(1);
  }
  const verifiedData: VerifiedTokensFile = JSON.parse(
    readFileSync(verifiedPath, "utf-8")
  );
  console.log(`Loaded ${verifiedData.count} verified tokens`);

  // Filter tokens (crypto wins over TradFi - no TradFi collision check)
  const tokensToSeed: Array<{ symbol: string; mint: string }> = [];
  const skippedTokens: Array<{ symbol: string; mint: string; reason: string }> =
    [];

  for (const [symbol, mint] of Object.entries(verifiedData.tokens)) {
    // Skip if symbol too long (contract MAX_SYMBOL_LENGTH = 10)
    if (symbol.length > 10) {
      skippedTokens.push({
        symbol,
        mint,
        reason: "Symbol too long (>10 chars)",
      });
      continue;
    }

    // Preserve original case
    tokensToSeed.push({ symbol, mint });
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

  // Continue from specific symbol if specified (case-sensitive match)
  let startIndex = 0;
  if (continueFrom) {
    const idx = tokensToSeed.findIndex(
      (t) => t.symbol === continueFrom
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

      // Pre-fetch update authorities for the batch
      const batchWithOwners: Array<{
        symbol: string;
        mint: string;
        owner: PublicKey;
        metadataPda: PublicKey;
      }> = [];
      const skippedInBatch: Array<{ symbol: string; mint: string }> = [];

      for (const { symbol, mint } of batch) {
        const mintPubkey = new PublicKey(mint);
        const metadataPda = getMetadataPda(mintPubkey);

        // Fetch update_authority from metadata
        const owner = await getUpdateAuthority(connection, mintPubkey);
        if (!owner) {
          console.log(`    ${symbol}: No metadata found, skipping`);
          skippedInBatch.push({ symbol, mint });
          results.tokens.push({
            symbol,
            mint,
            status: "failed",
            reason: "No metadata found - update_authority could not be determined",
          });
          results.totalFailed++;
          continue;
        }

        batchWithOwners.push({ symbol, mint, owner, metadataPda });
      }

      if (batchWithOwners.length === 0) {
        console.log(`  All tokens in batch skipped due to missing metadata`);
        continue;
      }

      for (const { symbol, mint, owner, metadataPda } of batchWithOwners) {
        const tokenPda = getTokenPda(symbol, PROGRAM_ID);
        const mintPubkey = new PublicKey(mint);

        const ix = await (program.methods as any)
          .seedSymbol(symbol, 2, owner) // 2 years for genesis seeding, pass owner
          .accounts({
            admin: adminKeypair.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: mintPubkey,
            tokenMetadata: metadataPda,
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
          const metadataPda = getMetadataPda(mintPubkey);

          // Fetch update_authority from metadata
          const owner = await getUpdateAuthority(connection, mintPubkey);
          if (!owner) {
            console.log(`    ${symbol}: No metadata found, skipping`);
            results.tokens.push({
              symbol,
              mint,
              status: "failed",
              reason: "No metadata found - update_authority could not be determined",
            });
            results.totalFailed++;
            continue;
          }

          const sig = await (program.methods as any)
            .seedSymbol(symbol, 2, owner) // 2 years for genesis seeding, pass owner
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              tokenAccount: tokenPda,
              tokenMint: mintPubkey,
              tokenMetadata: metadataPda,
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

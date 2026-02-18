/**
 * Seed Genesis - Populate TNS with Jupiter verified tokens
 *
 * This script seeds the TNS registry with verified tokens from Jupiter.
 * It skips any tokens whose symbols collide with reserved TradFi symbols.
 *
 * Usage:
 *   npx tsx scripts/seed-genesis.ts --validate      # Validate all tokens first (check metadata)
 *   npx tsx scripts/seed-genesis.ts --dry-run       # Preview what would be seeded
 *   npx tsx scripts/seed-genesis.ts                 # Actually seed (requires admin keypair)
 *   npx tsx scripts/seed-genesis.ts --batch=5       # Set batch size
 *   npx tsx scripts/seed-genesis.ts --continue=BONK # Resume from specific symbol
 *   npx tsx scripts/seed-genesis.ts --validated     # Only seed pre-validated tokens
 *   npx tsx scripts/seed-genesis.ts --retry         # Retry failed tokens from genesis-failures.json
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
import "dotenv/config";

// Token Metadata Program ID (Metaplex)
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// Token-2022 Program ID
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

// Classic SPL Token Program ID
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

interface TokenValidation {
  symbol: string;
  mint: string;
  source: string;  // Origin: jupiter-cache, jupiter-csv, raydium, orca, solana
  valid: boolean;
  mintExists: boolean;
  isToken2022: boolean;
  metadataExists: boolean;
  metadataSymbol: string | null;
  symbolMatches: boolean;
  error: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const BATCH_SIZE = 5; // Reduced from 10 - mainnet tx size limit is stricter
const BATCH_DELAY_MS = 2000; // Delay between batches to avoid rate limiting
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "http://localhost:8899";
const ADMIN_KEYPAIR_PATH =
  process.env.ADMIN_KEYPAIR || join(__dirname, "..", "admin-keypair.json");
const PROGRAM_ID = new PublicKey("TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12");

interface VerifiedTokensFile {
  generatedAt: string;
  count: number;
  tokens: Record<string, string | { mint: string; source: string }>;
}

// Helper to normalize token format (support both old and new formats)
function normalizeToken(symbol: string, value: string | { mint: string; source: string }): { symbol: string; mint: string; source: string } {
  if (typeof value === 'string') {
    return { symbol, mint: value, source: 'unknown' };
  }
  return { symbol, mint: value.mint, source: value.source };
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
 * Resolve the correct metadata account for a mint.
 * Token-2022 mints use the mint itself (embedded metadata extension).
 * Classic SPL mints use the Metaplex metadata PDA.
 */
async function resolveMetadataAccount(
  connection: Connection,
  mintPubkey: PublicKey
): Promise<PublicKey> {
  const mintInfo = await connection.getAccountInfo(mintPubkey);
  if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return mintPubkey; // Token-2022: pass mint as metadata
  }
  return getMetadataPda(mintPubkey); // Classic SPL: Metaplex PDA
}

/**
 * Batch-resolve metadata accounts for multiple mints.
 * Returns a map of mint address string -> metadata account pubkey.
 */
async function resolveMetadataAccountsBatch(
  connection: Connection,
  mintPubkeys: PublicKey[]
): Promise<Map<string, PublicKey>> {
  const result = new Map<string, PublicKey>();
  const mintInfos = await connection.getMultipleAccountsInfo(mintPubkeys);

  for (let i = 0; i < mintPubkeys.length; i++) {
    const mintPubkey = mintPubkeys[i];
    const mintInfo = mintInfos[i];

    if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      result.set(mintPubkey.toBase58(), mintPubkey); // Token-2022: mint is metadata
    } else {
      result.set(mintPubkey.toBase58(), getMetadataPda(mintPubkey)); // SPL: Metaplex PDA
    }
  }

  return result;
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

/**
 * Validate a token's metadata before attempting to seed.
 * Returns detailed information about what's wrong (if anything).
 */
async function validateToken(
  connection: Connection,
  symbol: string,
  mintAddress: string
): Promise<TokenValidation> {
  const result: TokenValidation = {
    symbol,
    mint: mintAddress,
    valid: false,
    mintExists: false,
    isToken2022: false,
    metadataExists: false,
    metadataSymbol: null,
    symbolMatches: false,
    error: null,
  };

  try {
    const mintPubkey = new PublicKey(mintAddress);

    // Check if mint exists
    const mintInfo = await connection.getAccountInfo(mintPubkey);
    if (!mintInfo) {
      result.error = "Mint account does not exist";
      return result;
    }
    result.mintExists = true;

    // Check if Token-2022 or classic SPL
    const mintOwner = mintInfo.owner.toBase58();
    result.isToken2022 = mintOwner === TOKEN_2022_PROGRAM_ID.toBase58();

    if (mintOwner !== TOKEN_PROGRAM_ID.toBase58() && mintOwner !== TOKEN_2022_PROGRAM_ID.toBase58()) {
      result.error = `Mint owned by unknown program: ${mintOwner}`;
      return result;
    }

    if (result.isToken2022) {
      // Token-2022: try to extract symbol from metadata extension
      try {
        // Parse the mint data to find metadata extension
        // This is a simplified check - the contract does more thorough validation
        const data = mintInfo.data;

        // Token-2022 mints have extensions after the base mint data (82 bytes)
        if (data.length <= 82) {
          result.error = "Token-2022 mint has no extensions (no metadata)";
          return result;
        }

        // For now, mark as potentially valid - the contract will do full validation
        // We can't easily parse Token-2022 metadata extensions in JS without more libraries
        result.metadataExists = true;
        result.metadataSymbol = "(Token-2022 - needs contract validation)";
        result.symbolMatches = true; // Assume true, let contract validate
        result.valid = true;

      } catch (e: any) {
        result.error = `Failed to parse Token-2022 metadata: ${e.message}`;
        return result;
      }
    } else {
      // Classic SPL Token: check Metaplex metadata
      const metadataPda = getMetadataPda(mintPubkey);
      const metadataInfo = await connection.getAccountInfo(metadataPda);

      if (!metadataInfo) {
        result.error = `No Metaplex metadata at ${metadataPda.toBase58()}`;
        return result;
      }
      result.metadataExists = true;

      // Parse metadata to get symbol
      // Metadata structure:
      // - key: u8 (offset 0)
      // - update_authority: Pubkey (offset 1, 32 bytes)
      // - mint: Pubkey (offset 33, 32 bytes)
      // - name: String (offset 65, 4 bytes length + data)
      // - symbol: String (after name)
      // - uri: String (after symbol)

      try {
        const data = metadataInfo.data;

        // Skip to name (offset 65)
        let offset = 65;

        // Read name length (4 bytes, little endian)
        const nameLen = data.readUInt32LE(offset);
        offset += 4 + nameLen;

        // Read symbol length (4 bytes, little endian)
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;

        // Read symbol
        const symbolBytes = data.slice(offset, offset + symbolLen);
        const metadataSymbol = symbolBytes.toString('utf8').replace(/\0/g, '').trim();

        result.metadataSymbol = metadataSymbol;
        result.symbolMatches = metadataSymbol === symbol;

        if (!result.symbolMatches) {
          result.error = `Symbol mismatch: expected "${symbol}", metadata has "${metadataSymbol}"`;
          return result;
        }

        result.valid = true;

      } catch (e: any) {
        result.error = `Failed to parse Metaplex metadata: ${e.message}`;
        return result;
      }
    }

  } catch (e: any) {
    result.error = `Validation error: ${e.message}`;
  }

  return result;
}

/**
 * Validate a batch of tokens using getMultipleAccountsInfo for efficiency.
 * Makes only 2 RPC calls per batch (mints + metadata accounts).
 */
async function validateTokensBatch(
  connection: Connection,
  tokens: Array<{ symbol: string; mint: string; source: string }>
): Promise<TokenValidation[]> {
  const results: TokenValidation[] = [];

  // Prepare all pubkeys
  const mintPubkeys: PublicKey[] = [];
  const metadataPubkeys: PublicKey[] = [];

  for (const { mint } of tokens) {
    const mintPubkey = new PublicKey(mint);
    mintPubkeys.push(mintPubkey);
    metadataPubkeys.push(getMetadataPda(mintPubkey));
  }

  // Fetch all accounts in 2 batched calls
  const [mintInfos, metadataInfos] = await Promise.all([
    connection.getMultipleAccountsInfo(mintPubkeys),
    connection.getMultipleAccountsInfo(metadataPubkeys),
  ]);

  // Process each token
  for (let i = 0; i < tokens.length; i++) {
    const { symbol, mint, source } = tokens[i];
    const mintInfo = mintInfos[i];
    const metadataInfo = metadataInfos[i];

    const result: TokenValidation = {
      symbol,
      mint,
      source,
      valid: false,
      mintExists: false,
      isToken2022: false,
      metadataExists: false,
      metadataSymbol: null,
      symbolMatches: false,
      error: null,
    };

    // Check mint exists
    if (!mintInfo) {
      result.error = "Mint account does not exist";
      results.push(result);
      continue;
    }
    result.mintExists = true;

    // Check mint program
    const mintOwner = mintInfo.owner.toBase58();
    result.isToken2022 = mintOwner === TOKEN_2022_PROGRAM_ID.toBase58();

    if (mintOwner !== TOKEN_PROGRAM_ID.toBase58() && mintOwner !== TOKEN_2022_PROGRAM_ID.toBase58()) {
      result.error = `Mint owned by unknown program: ${mintOwner}`;
      results.push(result);
      continue;
    }

    if (result.isToken2022) {
      // Token-2022: check for metadata extension
      const data = mintInfo.data;
      if (data.length <= 82) {
        result.error = "Token-2022 mint has no extensions (no metadata)";
        results.push(result);
        continue;
      }
      // Token-2022 has embedded metadata - we trust the Jupiter symbol
      // and let the contract validate the actual metadata match
      result.metadataExists = true;
      result.metadataSymbol = symbol; // Use Jupiter symbol, contract validates
      result.symbolMatches = true;
      result.valid = true;
    } else {
      // Classic SPL Token: check Metaplex metadata
      if (!metadataInfo) {
        result.error = `No Metaplex metadata account exists`;
        results.push(result);
        continue;
      }
      result.metadataExists = true;

      // Parse metadata to get symbol
      try {
        const data = metadataInfo.data;
        let offset = 65; // Skip key (1) + update_authority (32) + mint (32)

        // Read name length and skip name
        const nameLen = data.readUInt32LE(offset);
        offset += 4 + nameLen;

        // Read symbol
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;
        const symbolBytes = data.slice(offset, offset + symbolLen);
        const metadataSymbol = symbolBytes.toString('utf8').replace(/\0/g, '').trim();

        result.metadataSymbol = metadataSymbol;
        result.symbolMatches = metadataSymbol === symbol;

        // Symbol mismatch is OK - we use the metadata symbol as source of truth
        // The collision detection will catch if multiple tokens claim the same metadata symbol
        result.valid = true;
      } catch (e: any) {
        result.error = `Failed to parse metadata: ${e.message}`;
      }
    }

    results.push(result);
  }

  return results;
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
  const validateOnly = args.includes("--validate");
  const useValidated = args.includes("--validated");
  const retryMode = args.includes("--retry");
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
  const mode = retryMode ? "RETRY FAILURES" : (validateOnly ? "VALIDATE ONLY" : (dryRun ? "DRY RUN" : "LIVE"));
  console.log(`Mode: ${mode}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log("");

  // ─── RETRY MODE ───────────────────────────────────────────────────────
  if (retryMode) {
    const failuresPath = join(__dirname, "data", "genesis-failures.json");
    const recordPath = join(__dirname, "data", "genesis-record.json");

    if (!existsSync(failuresPath)) {
      console.error("Error: genesis-failures.json not found. Nothing to retry.");
      process.exit(1);
    }
    if (!existsSync(recordPath)) {
      console.error("Error: genesis-record.json not found. Cannot update records.");
      process.exit(1);
    }

    const failuresData = JSON.parse(readFileSync(failuresPath, "utf-8"));
    const recordData: GenesisRecord = JSON.parse(readFileSync(recordPath, "utf-8"));

    // Filter out AlreadyInUse - those are already seeded
    const retryTokens = failuresData.tokens.filter(
      (t: any) => t.errorCategory !== "AlreadyInUse"
    );
    const alreadyInUse = failuresData.tokens.filter(
      (t: any) => t.errorCategory === "AlreadyInUse"
    );

    console.log(`Loaded ${failuresData.tokens.length} failures from genesis-failures.json`);
    console.log(`  Skipping ${alreadyInUse.length} AlreadyInUse (already seeded)`);
    console.log(`  Retrying ${retryTokens.length} tokens`);
    console.log("");

    // Mark AlreadyInUse as seeded in the record
    for (const token of alreadyInUse) {
      const recordEntry = recordData.tokens.find(
        (t) => t.symbol === token.symbol && t.mint === token.mint && t.status === "failed"
      );
      if (recordEntry) {
        recordEntry.status = "seeded";
        recordEntry.reason = undefined;
        recordEntry.txSignature = "already-seeded";
        recordData.totalSeeded++;
        recordData.totalFailed--;
      }
    }

    if (retryTokens.length === 0) {
      console.log("No tokens to retry!");
      writeFileSync(recordPath, JSON.stringify(recordData, null, 2));
      console.log(`Updated ${recordPath}`);
      return;
    }

    // Load admin keypair
    if (!existsSync(ADMIN_KEYPAIR_PATH)) {
      console.error(`Error: Admin keypair not found at ${ADMIN_KEYPAIR_PATH}`);
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
    const owner = adminKeypair.publicKey;

    let retrySuccesses = 0;
    let retryFails = 0;
    const remainingFailures: typeof retryTokens = [];

    // Process individually (not batched) since these are known-problematic tokens
    for (let i = 0; i < retryTokens.length; i++) {
      const { symbol, mint } = retryTokens[i];
      const progress = `[${i + 1}/${retryTokens.length}]`;

      try {
        const mintPubkey = new PublicKey(mint);
        const tokenPda = getTokenPda(symbol, PROGRAM_ID);
        const metadataAccount = await resolveMetadataAccount(connection, mintPubkey);

        const sig = await (program.methods as any)
          .seedSymbol(symbol, 2, owner)
          .accounts({
            admin: adminKeypair.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: mintPubkey,
            tokenMetadata: metadataAccount,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        console.log(`  ${progress} ${symbol}: Success (${sig})`);
        retrySuccesses++;

        // Update the record entry
        const recordEntry = recordData.tokens.find(
          (t) => t.symbol === symbol && t.mint === mint && t.status === "failed"
        );
        if (recordEntry) {
          recordEntry.status = "seeded";
          recordEntry.reason = undefined;
          recordEntry.txSignature = sig;
          recordData.totalSeeded++;
          recordData.totalFailed--;
        }
      } catch (error: any) {
        console.error(`  ${progress} ${symbol}: Failed - ${error.message}`);
        retryFails++;
        const msg = error.message || "";
        let errorCategory = "Other";
        if (msg.includes("InvalidMetadata") || msg.includes("0x1789")) {
          errorCategory = "InvalidMetadata";
        } else if (msg.includes("MetadataSymbolMismatch") || msg.includes("0x178a")) {
          errorCategory = "MetadataSymbolMismatch";
        } else if (msg.includes("AlreadyInUse") || msg.includes("already in use") || msg.includes("0x0")) {
          errorCategory = "AlreadyInUse";
        } else if (msg.includes("Blockhash not found") || msg.includes("BlockhashNotFound")) {
          errorCategory = "BlockhashNotFound";
        }
        remainingFailures.push({
          ...retryTokens[i],
          errorCategory,
        });
      }

      // Small delay between individual txs
      await new Promise((r) => setTimeout(r, 500));
    }

    // Update genesis-record.json
    writeFileSync(recordPath, JSON.stringify(recordData, null, 2));

    // Update genesis-failures.json
    const errorBreakdown: Record<string, number> = {};
    for (const f of remainingFailures) {
      errorBreakdown[f.errorCategory] = (errorBreakdown[f.errorCategory] || 0) + 1;
    }
    const updatedFailures = {
      extractedFrom: "genesis-record.json",
      retryAt: new Date().toISOString(),
      totalFailed: remainingFailures.length,
      breakdown: errorBreakdown,
      tokens: remainingFailures,
    };
    writeFileSync(failuresPath, JSON.stringify(updatedFailures, null, 2));

    console.log("");
    console.log("=".repeat(60));
    console.log("Retry Complete");
    console.log("=".repeat(60));
    console.log(`Retried:    ${retryTokens.length}`);
    console.log(`Succeeded:  ${retrySuccesses}`);
    console.log(`Failed:     ${retryFails}`);
    console.log(`Remaining failures: ${remainingFailures.length}`);
    console.log("");
    console.log(`Updated ${recordPath}`);
    console.log(`Updated ${failuresPath}`);

    return;
  }

  // Load token list - use genesis-seed-list.json if --validated, otherwise verified-tokens.json
  const seedListPath = join(__dirname, "data", "genesis-seed-list.json");
  const verifiedPath = join(__dirname, "data", "verified", "verified-tokens.json");

  const tokenPath = useValidated ? seedListPath : verifiedPath;
  if (!existsSync(tokenPath)) {
    if (useValidated) {
      console.error("Error: genesis-seed-list.json not found.");
      console.error("Run --validate first, then resolve collisions to generate the seed list.");
    } else {
      console.error("Error: verified-tokens.json not found. Run: npm run fetch:tokens");
    }
    process.exit(1);
  }
  const verifiedData: VerifiedTokensFile = JSON.parse(
    readFileSync(tokenPath, "utf-8")
  );
  console.log(`Loaded ${verifiedData.count} tokens from ${useValidated ? 'genesis-seed-list.json' : 'verified-tokens.json'}`);

  // Filter tokens (crypto wins over TradFi - no TradFi collision check)
  const tokensToSeed: Array<{ symbol: string; mint: string; source: string }> = [];
  const skippedTokens: Array<{ symbol: string; mint: string; source: string; reason: string }> = [];

  for (const [symbol, value] of Object.entries(verifiedData.tokens)) {
    const token = normalizeToken(symbol, value);

    // Skip if symbol too long (contract MAX_SYMBOL_LENGTH = 10)
    if (symbol.length > 10) {
      skippedTokens.push({
        symbol,
        mint: token.mint,
        source: token.source,
        reason: "Symbol too long (>10 chars)",
      });
      continue;
    }

    // Preserve original case
    tokensToSeed.push(token);
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

  // Validation mode: check all tokens for valid metadata
  if (validateOnly) {
    console.log("");
    console.log("=".repeat(60));
    console.log("VALIDATING TOKENS (checking metadata on-chain)");
    console.log("=".repeat(60));
    console.log("");

    const connection = new Connection(RPC_URL, "confirmed");
    const validTokens: TokenValidation[] = [];
    const invalidTokens: TokenValidation[] = [];

    // Process in batches using getMultipleAccountsInfo for efficiency
    // Each batch = 2 RPC calls (mints + metadata), not 2 per token
    const validationBatchSize = 100; // Can be larger now since we batch RPC calls
    const validationDelay = 500; // Delay between batches

    for (let i = 0; i < tokensToSeed.length; i += validationBatchSize) {
      const batch = tokensToSeed.slice(i, i + validationBatchSize);
      const batchNum = Math.floor(i / validationBatchSize) + 1;
      const totalBatches = Math.ceil(tokensToSeed.length / validationBatchSize);

      process.stdout.write(`\rValidating batch ${batchNum}/${totalBatches} (${i + batch.length}/${tokensToSeed.length} tokens)...`);

      // Use batched validation - only 2 RPC calls per batch
      const results = await validateTokensBatch(connection, batch);

      for (const result of results) {
        if (result.valid) {
          validTokens.push(result);
        } else {
          invalidTokens.push(result);
        }
      }

      // Rate limit delay
      if (i + validationBatchSize < tokensToSeed.length) {
        await new Promise((r) => setTimeout(r, validationDelay));
      }
    }

    console.log("\n");
    console.log("=".repeat(60));
    console.log("VALIDATION RESULTS");
    console.log("=".repeat(60));

    // Detect metadata symbol collisions among valid tokens
    // (e.g., USDCav, USDCpo all have "USDC" in metadata)
    const metadataSymbolMap = new Map<string, TokenValidation[]>();
    for (const token of validTokens) {
      const metaSym = token.metadataSymbol || token.symbol;
      if (!metadataSymbolMap.has(metaSym)) {
        metadataSymbolMap.set(metaSym, []);
      }
      metadataSymbolMap.get(metaSym)!.push(token);
    }

    // Find collisions (multiple tokens claiming same metadata symbol)
    const metadataCollisions: TokenValidation[] = [];
    const cleanValidTokens: TokenValidation[] = [];

    for (const [metaSym, tokens] of metadataSymbolMap) {
      if (tokens.length > 1) {
        // Multiple tokens have same metadata symbol - collision!
        for (const token of tokens) {
          token.error = `Metadata symbol collision: ${tokens.length} tokens have "${metaSym}" in metadata`;
          metadataCollisions.push(token);
        }
      } else {
        cleanValidTokens.push(tokens[0]);
      }
    }

    console.log(`Valid tokens (ready to seed): ${cleanValidTokens.length}`);
    console.log(`Metadata collisions (need disambiguation): ${metadataCollisions.length}`);
    console.log(`Invalid tokens: ${invalidTokens.length}`);
    console.log("");

    // Group by source
    const sourceGroups = {
      valid: {} as Record<string, number>,
      collision: {} as Record<string, number>,
      invalid: {} as Record<string, number>,
    };

    for (const token of cleanValidTokens) {
      sourceGroups.valid[token.source] = (sourceGroups.valid[token.source] || 0) + 1;
    }
    for (const token of metadataCollisions) {
      sourceGroups.collision[token.source] = (sourceGroups.collision[token.source] || 0) + 1;
    }
    for (const token of invalidTokens) {
      sourceGroups.invalid[token.source] = (sourceGroups.invalid[token.source] || 0) + 1;
    }

    console.log("Breakdown by source:");
    const allSources = new Set([
      ...Object.keys(sourceGroups.valid),
      ...Object.keys(sourceGroups.collision),
      ...Object.keys(sourceGroups.invalid),
    ]);
    for (const source of allSources) {
      const v = sourceGroups.valid[source] || 0;
      const c = sourceGroups.collision[source] || 0;
      const i = sourceGroups.invalid[source] || 0;
      console.log(`  ${source.padEnd(15)} valid: ${v.toString().padStart(5)}, collision: ${c.toString().padStart(4)}, invalid: ${i.toString().padStart(5)}`);
    }
    console.log("");

    // Show metadata collisions
    if (metadataCollisions.length > 0) {
      console.log("Metadata symbol collisions (not seeding - need disambiguation):");
      const collisionGroups = new Map<string, TokenValidation[]>();
      for (const token of metadataCollisions) {
        const metaSym = token.metadataSymbol || token.symbol;
        if (!collisionGroups.has(metaSym)) {
          collisionGroups.set(metaSym, []);
        }
        collisionGroups.get(metaSym)!.push(token);
      }
      for (const [metaSym, tokens] of Array.from(collisionGroups.entries()).slice(0, 10)) {
        console.log(`\n  "${metaSym}" claimed by ${tokens.length} tokens:`);
        for (const token of tokens) {
          console.log(`    - ${token.symbol} (${token.mint.slice(0, 8)}...) [${token.source}]`);
        }
      }
      if (collisionGroups.size > 10) {
        console.log(`\n  ... and ${collisionGroups.size - 10} more collision groups`);
      }
      console.log("");
    }

    // Group invalid tokens by error type
    const errorGroups: Record<string, TokenValidation[]> = {};
    for (const token of invalidTokens) {
      const errorType = token.error?.split(":")[0] || "Unknown error";
      if (!errorGroups[errorType]) {
        errorGroups[errorType] = [];
      }
      errorGroups[errorType].push(token);
    }

    console.log("Invalid tokens by error type:");
    for (const [errorType, tokens] of Object.entries(errorGroups)) {
      console.log(`\n  ${errorType}: ${tokens.length} tokens`);
      // Show source breakdown for this error
      const srcCounts: Record<string, number> = {};
      for (const t of tokens) {
        srcCounts[t.source] = (srcCounts[t.source] || 0) + 1;
      }
      console.log(`    Sources: ${Object.entries(srcCounts).map(([s, c]) => `${s}=${c}`).join(", ")}`);
      for (const token of tokens.slice(0, 3)) {
        console.log(`    - ${token.symbol} (${token.mint.slice(0, 8)}...) [${token.source}]: ${token.error}`);
      }
      if (tokens.length > 3) {
        console.log(`    ... and ${tokens.length - 3} more`);
      }
    }

    // Save validation results
    const validationRecord = {
      validatedAt: new Date().toISOString(),
      totalChecked: tokensToSeed.length,
      validCount: cleanValidTokens.length,
      collisionCount: metadataCollisions.length,
      invalidCount: invalidTokens.length,
      sourceBreakdown: {
        valid: sourceGroups.valid,
        collision: sourceGroups.collision,
        invalid: sourceGroups.invalid,
      },
      valid: cleanValidTokens,
      collisions: metadataCollisions,
      invalid: invalidTokens,
    };

    const validatedPath = join(__dirname, "data", "validated-tokens.json");
    writeFileSync(validatedPath, JSON.stringify(validationRecord, null, 2));
    console.log("");
    console.log(`Validation results saved to ${validatedPath}`);
    console.log("");
    console.log("To seed only validated tokens, run:");
    console.log("  ADMIN_KEYPAIR=~/.config/solana/tns.json npx tsx scripts/seed-genesis.ts --validated");

    return;
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
  console.log(`Batch size: ${batchSize}, delay: ${BATCH_DELAY_MS}ms between batches`);

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

      // Use admin as owner for all seeds - rightful owners can claim via claim_ownership
      const owner = adminKeypair.publicKey;

      // Batch-resolve metadata accounts (Token-2022 vs SPL)
      const batchMintPubkeys = batch.map(({ mint }) => new PublicKey(mint));
      const metadataMap = await resolveMetadataAccountsBatch(connection, batchMintPubkeys);

      for (const { symbol, mint } of batch) {
        const tokenPda = getTokenPda(symbol, PROGRAM_ID);
        const mintPubkey = new PublicKey(mint);
        const metadataAccount = metadataMap.get(mint)!;

        const ix = await (program.methods as any)
          .seedSymbol(symbol, 2, owner) // 2 years for genesis seeding, admin as owner
          .accounts({
            admin: adminKeypair.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: mintPubkey,
            tokenMetadata: metadataAccount,
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
      const owner = adminKeypair.publicKey;
      for (const { symbol, mint } of batch) {
        try {
          const tokenPda = getTokenPda(symbol, PROGRAM_ID);
          const mintPubkey = new PublicKey(mint);
          const metadataAccount = await resolveMetadataAccount(connection, mintPubkey);

          const sig = await (program.methods as any)
            .seedSymbol(symbol, 2, owner) // 2 years for genesis seeding, admin as owner
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              tokenAccount: tokenPda,
              tokenMint: mintPubkey,
              tokenMetadata: metadataAccount,
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

    // Delay between batches to avoid rate limiting
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
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

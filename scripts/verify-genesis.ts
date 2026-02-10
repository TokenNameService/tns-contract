/**
 * Verify Genesis - Check that all seeded symbols have correct mints
 *
 * This script verifies that:
 * 1. Each symbol PDA exists on-chain
 * 2. The mint stored in the PDA matches the expected Jupiter verified mint
 * 3. The symbol is not expired
 *
 * Usage:
 *   npx tsx scripts/verify-genesis.ts                    # Verify all from verified-tokens.json
 *   npx tsx scripts/verify-genesis.ts --from-record      # Verify from genesis-record.json
 *   npx tsx scripts/verify-genesis.ts --symbol BONK      # Verify single symbol
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";
const PROGRAM_ID = new PublicKey("TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12");

interface VerifiedTokensFile {
  source: string;
  fetchedAt: string;
  count: number;
  tokens: Record<string, string>;
}

interface GenesisRecord {
  tokens: Array<{
    symbol: string;
    mint: string;
    status: "seeded" | "skipped" | "failed";
  }>;
}

interface TokenAccount {
  symbol: string;
  mint: PublicKey;
  owner: PublicKey;
  registeredAt: anchor.BN;
  bump: number;
  expiresAt: anchor.BN;
  reserved: number[];
}

interface VerificationResult {
  symbol: string;
  expectedMint: string;
  status: "valid" | "missing" | "mismatch" | "expired" | "error";
  actualMint?: string;
  owner?: string;
  expiresAt?: string;
  error?: string;
}

function getTokenPda(symbol: string, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token"), Buffer.from(symbol)],
    programId
  );
  return pda;
}

async function fetchTokenAccount(
  connection: Connection,
  pda: PublicKey,
  idl: any
): Promise<TokenAccount | null> {
  try {
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo) return null;

    // Decode using anchor
    const coder = new anchor.BorshAccountsCoder(idl);
    const decoded = coder.decode("token", accountInfo.data);
    return decoded as TokenAccount;
  } catch {
    return null;
  }
}

async function verifySymbol(
  connection: Connection,
  idl: any,
  symbol: string,
  expectedMint: string
): Promise<VerificationResult> {
  const pda = getTokenPda(symbol, PROGRAM_ID);

  try {
    const account = await fetchTokenAccount(connection, pda, idl);

    if (!account) {
      return {
        symbol,
        expectedMint,
        status: "missing",
      };
    }

    const actualMint = account.mint.toBase58();
    const now = Math.floor(Date.now() / 1000);

    if (actualMint !== expectedMint) {
      return {
        symbol,
        expectedMint,
        status: "mismatch",
        actualMint,
        owner: account.owner.toBase58(),
        expiresAt: new Date(account.expiresAt.toNumber() * 1000).toISOString(),
      };
    }

    if (account.expiresAt.toNumber() < now) {
      return {
        symbol,
        expectedMint,
        status: "expired",
        actualMint,
        owner: account.owner.toBase58(),
        expiresAt: new Date(account.expiresAt.toNumber() * 1000).toISOString(),
      };
    }

    return {
      symbol,
      expectedMint,
      status: "valid",
      actualMint,
      owner: account.owner.toBase58(),
      expiresAt: new Date(account.expiresAt.toNumber() * 1000).toISOString(),
    };
  } catch (error: any) {
    return {
      symbol,
      expectedMint,
      status: "error",
      error: error.message,
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fromRecord = args.includes("--from-record");
  const singleSymbol = args
    .find((a) => a.startsWith("--symbol="))
    ?.split("=")[1];
  const outputJson = args.includes("--json");

  console.log("=".repeat(60));
  console.log("TNS Genesis Verification");
  console.log("=".repeat(60));
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log("");

  // Load tokens to verify
  let tokensToVerify: Array<{ symbol: string; mint: string }> = [];

  if (singleSymbol) {
    // Verify single symbol - need to look up its mint (case-sensitive)
    const verifiedPath = join(__dirname, "data", "verified", "verified-tokens.json");
    if (existsSync(verifiedPath)) {
      const verifiedData: VerifiedTokensFile = JSON.parse(
        readFileSync(verifiedPath, "utf-8")
      );
      const mint = verifiedData.tokens[singleSymbol];
      if (mint) {
        tokensToVerify = [{ symbol: singleSymbol, mint }];
      } else {
        console.error(
          `Symbol ${singleSymbol} not found in verified-tokens.json (case-sensitive)`
        );
        process.exit(1);
      }
    }
  } else if (fromRecord) {
    // Load from genesis record
    const recordPath = join(__dirname, "data", "genesis-record.json");
    if (!existsSync(recordPath)) {
      console.error(
        "Error: genesis-record.json not found. Run seed-genesis.ts first."
      );
      process.exit(1);
    }
    const record: GenesisRecord = JSON.parse(readFileSync(recordPath, "utf-8"));
    tokensToVerify = record.tokens
      .filter((t) => t.status === "seeded")
      .map((t) => ({ symbol: t.symbol, mint: t.mint }));
    console.log(
      `Loaded ${tokensToVerify.length} seeded tokens from genesis record`
    );
  } else {
    // Load from verified tokens
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
    tokensToVerify = Object.entries(verifiedData.tokens).map(
      ([symbol, mint]) => ({
        symbol,
        mint,
      })
    );
    console.log(
      `Loaded ${tokensToVerify.length} tokens from verified-tokens.json`
    );
  }

  // Connect
  const connection = new Connection(RPC_URL, "confirmed");

  // Load IDL
  const idlPath = join(__dirname, "..", "target", "idl", "tns.json");
  if (!existsSync(idlPath)) {
    console.error("Error: IDL not found. Run anchor build first.");
    process.exit(1);
  }
  const idl = JSON.parse(readFileSync(idlPath, "utf-8"));

  console.log("");
  console.log(`Verifying ${tokensToVerify.length} symbols...`);
  console.log("");

  // Verify each
  const results: VerificationResult[] = [];
  let valid = 0,
    missing = 0,
    mismatch = 0,
    expired = 0,
    errors = 0;

  for (let i = 0; i < tokensToVerify.length; i++) {
    const { symbol, mint } = tokensToVerify[i];
    const result = await verifySymbol(connection, idl, symbol, mint);
    results.push(result);

    const status = result.status.toUpperCase().padEnd(8);
    const progress = `[${(i + 1).toString().padStart(4)}/${
      tokensToVerify.length
    }]`;

    switch (result.status) {
      case "valid":
        valid++;
        if (!outputJson) console.log(`${progress} ${status} ${symbol}`);
        break;
      case "missing":
        missing++;
        console.log(`${progress} ${status} ${symbol} - Not found on-chain`);
        break;
      case "mismatch":
        mismatch++;
        console.log(
          `${progress} ${status} ${symbol} - Expected ${mint.slice(
            0,
            8
          )}..., got ${result.actualMint?.slice(0, 8)}...`
        );
        break;
      case "expired":
        expired++;
        console.log(
          `${progress} ${status} ${symbol} - Expired at ${result.expiresAt}`
        );
        break;
      case "error":
        errors++;
        console.log(`${progress} ${status} ${symbol} - ${result.error}`);
        break;
    }

    // Small delay to avoid rate limiting
    if (i % 50 === 49) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Summary
  console.log("");
  console.log("=".repeat(60));
  console.log("Verification Summary");
  console.log("=".repeat(60));
  console.log(`Total checked: ${tokensToVerify.length}`);
  console.log(
    `Valid:         ${valid} (${((valid / tokensToVerify.length) * 100).toFixed(
      1
    )}%)`
  );
  console.log(`Missing:       ${missing}`);
  console.log(`Mismatch:      ${mismatch}`);
  console.log(`Expired:       ${expired}`);
  console.log(`Errors:        ${errors}`);

  // Write detailed results
  const outputPath = join(__dirname, "data", "verification-results.json");
  const output = {
    verifiedAt: new Date().toISOString(),
    network: RPC_URL.includes("mainnet")
      ? "mainnet-beta"
      : RPC_URL.includes("devnet")
      ? "devnet"
      : "localnet",
    programId: PROGRAM_ID.toBase58(),
    summary: {
      total: tokensToVerify.length,
      valid,
      missing,
      mismatch,
      expired,
      errors,
    },
    results,
  };
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log("");
  console.log(`Detailed results written to ${outputPath}`);

  // Exit with error if any issues found
  if (mismatch > 0 || errors > 0) {
    process.exit(1);
  }
}

main().catch(console.error);

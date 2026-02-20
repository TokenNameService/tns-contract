/**
 * Demo CLI for the TNS (Token Naming Service) Program
 *
 * Usage:
 *   npx tsx app/demo.ts init                                  - Initialize config (one-time, starts PAUSED)
 *   npx tsx app/demo.ts create-atas                           - Create fee collector ATAs for USDC/USDT/TNS
 *   npx tsx app/demo.ts register <symbol> <mint> <years>      - Register a symbol (pays with SOL)
 *   npx tsx app/demo.ts renew <symbol> <years>                - Renew a symbol (pays with SOL)
 *   npx tsx app/demo.ts update-mint <symbol> <new_mint>       - Update mint for a symbol (pays with SOL)
 *   npx tsx app/demo.ts transfer <symbol> <new_owner>         - Transfer symbol ownership
 *   npx tsx app/demo.ts cancel <symbol>                       - Cancel and close symbol account
 *   npx tsx app/demo.ts verify <symbol>                       - Verify symbol matches metadata (keeper enforcement)
 *   npx tsx app/demo.ts lookup <symbol>                       - Lookup symbol details
 *   npx tsx app/demo.ts lookup-mint <mint>                    - Reverse lookup by mint
 *   npx tsx app/demo.ts pda <symbol>                          - Derive token PDA
 *
 * Admin commands:
 *   npx tsx app/demo.ts config                                - View current config state (paused, phase, etc.)
 *   npx tsx app/demo.ts seed <symbol> <mint> <owner> [years]  - Seed a symbol (admin only, free, default 2 years)
 *   npx tsx app/demo.ts unpause                               - Unpause the protocol (admin only)
 *   npx tsx app/demo.ts pause                                 - Pause the protocol (admin only)
 *   npx tsx app/demo.ts set-phase <phase>                     - Set protocol phase 1/2/3 (admin only)
 *   npx tsx app/demo.ts admin-update <symbol> [options]       - Force-update a symbol (admin only)
 *   npx tsx app/demo.ts admin-close <symbol>                  - Force-close a symbol (admin only)
 */

import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Signer,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Token mints (matching constants.rs)
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const TNS_MINT = new PublicKey("6jwcLLjhEcUrnnPtnWvqVKEeAzSTXT6qtV1GEjcopump");

// Program ID: set via TNS_PROGRAM_ID env var (required for deployed program)
const PROGRAM_ID = new PublicKey(
  process.env.TNS_PROGRAM_ID || "TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12"
);

// Token Metadata Program ID (Metaplex)
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// RPC URL: defaults to local surfpool/validator, override with SOLANA_RPC_URL env var
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";

const IDL_PATH = path.join(__dirname, "../target/idl/tns.json");

// Pyth SOL/USD feed ID (hex, same on mainnet and devnet)
const SOL_USD_PYTH_FEED_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Constants matching the contract
const GRACE_PERIOD_SECONDS = 90 * 24 * 60 * 60; // 90 days

function loadIDL() {
  if (!fs.existsSync(IDL_PATH)) {
    console.error(
      "IDL not found. Run 'anchor build' in the contract directory first."
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
}

function getProgram(provider: AnchorProvider): Program {
  return new Program(loadIDL(), provider);
}

function loadKeypair(): Keypair {
  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  if (!fs.existsSync(keypairPath)) {
    console.error("Keypair not found at ~/.config/solana/id.json");
    console.error("Run: solana-keygen new");
    process.exit(1);
  }
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function getProvider(): AnchorProvider {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(loadKeypair());
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

interface PriceUpdateData {
  preInstructions: TransactionInstruction[];
  closeInstructions: TransactionInstruction[];
  priceUpdateAccount: PublicKey;
  ephemeralSigners: Signer[];
}

async function buildPriceUpdateInstructions(connection: Connection): Promise<PriceUpdateData> {
  const hermes = new HermesClient("https://hermes.pyth.network");
  const priceUpdates = await hermes.getLatestPriceUpdates([SOL_USD_PYTH_FEED_ID]);

  if (!priceUpdates?.binary?.data?.[0]) {
    throw new Error("Failed to fetch price update from Hermes");
  }

  const dummyWallet = new Wallet(Keypair.generate());
  const pythReceiver = new PythSolanaReceiver({ connection, wallet: dummyWallet });

  const { postInstructions, priceFeedIdToPriceUpdateAccount, closeInstructions } =
    await pythReceiver.buildPostPriceUpdateInstructions(priceUpdates.binary.data);

  const priceUpdateAccount = priceFeedIdToPriceUpdateAccount[SOL_USD_PYTH_FEED_ID];
  if (!priceUpdateAccount) {
    throw new Error("Price update account not found for SOL/USD feed");
  }

  const preIxs: TransactionInstruction[] = [];
  const allSigners: Signer[] = [];

  for (const ixWithSigners of postInstructions) {
    preIxs.push(ixWithSigners.instruction);
    allSigners.push(...ixWithSigners.signers);
  }

  const closeIxs: TransactionInstruction[] = [];
  for (const ixWithSigners of closeInstructions) {
    closeIxs.push(ixWithSigners.instruction);
    allSigners.push(...ixWithSigners.signers);
  }

  return {
    preInstructions: preIxs,
    closeInstructions: closeIxs,
    priceUpdateAccount,
    ephemeralSigners: allSigners,
  };
}

function getConfigPda(): PublicKey {
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  return configPda;
}

function getTokenPda(symbol: string): PublicKey {
  // Symbols are case-sensitive (mSOL != MSOL)
  const [tokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token"), Buffer.from(symbol)],
    PROGRAM_ID
  );
  return tokenPda;
}

function getMetadataPda(mint: PublicKey): PublicKey {
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return metadataPda;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split("T")[0];
}

function getSymbolStatus(expiresAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  if (now <= expiresAt) {
    const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60));
    return `ACTIVE (${daysLeft} days remaining)`;
  } else if (now <= expiresAt + GRACE_PERIOD_SECONDS) {
    const daysInGrace = Math.ceil(
      (expiresAt + GRACE_PERIOD_SECONDS - now) / (24 * 60 * 60)
    );
    return `GRACE PERIOD (${daysInGrace} days to renew)`;
  } else {
    return "EXPIRED (can be claimed)";
  }
}

async function initConfig(feeCollectorPubkey?: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  const admin = provider.wallet.publicKey;
  const feeCollector = feeCollectorPubkey
    ? new PublicKey(feeCollectorPubkey)
    : admin;

  // Pyth SOL/USD price feed (v2): mainnet address auto-fetched by surfpool
  // Override with PYTH_SOL_USD_FEED env var if needed
  const solUsdPythFeed = new PublicKey(
    process.env.PYTH_SOL_USD_FEED || "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"
  );

  console.log("Initializing TNS config...");
  console.log(`  Admin: ${admin}`);
  console.log(`  Fee Collector: ${feeCollector}`);
  console.log(`  SOL/USD Pyth Feed: ${solUsdPythFeed}`);
  console.log(`  Config PDA: ${configPda}`);

  try {
    const tx = await program.methods
      .initialize()
      .accounts({
        payer: provider.wallet.publicKey,
        admin: provider.wallet.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
        solUsdPythFeed: solUsdPythFeed,
        feeCollector: feeCollector,
      })
      .rpc();

    console.log("\nTNS config initialized!");
    console.log(`  Transaction: ${tx}`);
  } catch (err: unknown) {
    const error = err as Error;
    if (error.message?.includes("already in use")) {
      // Fetch and display actual on-chain config
      const config = await (program.account as any).config.fetch(configPda);
      console.log("\nConfig already initialized. Current on-chain values:");
      console.log(`  Admin: ${config.admin}`);
      console.log(`  Fee Collector: ${config.feeCollector}`);
      console.log(`  Paused: ${config.paused}`);
      console.log(`  Phase: ${config.phase}`);
    } else {
      throw err;
    }
  }
}

async function registerSymbol(symbol: string, mint: string, years: number) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const mintPubkey = new PublicKey(mint);
  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);
  const tokenMetadata = getMetadataPda(mintPubkey);

  // Check if symbol already exists
  try {
    const existing = await (program.account as any).token.fetch(tokenPda);
    console.log(`\nError: Symbol "${symbol}" is already registered.`);
    console.log(`  Owner: ${existing.owner}`);
    console.log(`  Mint: ${existing.mint}`);
    console.log(`  Expires: ${formatDate(existing.expiresAt.toNumber())}`);
    console.log(`\nTo renew: npx tsx app/demo.ts renew ${symbol} <years>`);
    process.exit(1);
  } catch {
    // Account doesn't exist - good, we can register
  }

  // Get fee collector from config
  const config = await (program.account as any).config.fetch(configPda);
  const feeCollector = config.feeCollector;

  console.log("Registering symbol with SOL...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Token Mint: ${mintPubkey}`);
  console.log(`  Years: ${years}`);
  console.log(`  Owner: ${provider.wallet.publicKey}`);
  console.log(`  Token PDA: ${tokenPda}`);

  // Fetch Pyth price update from Hermes
  console.log("  Fetching SOL/USD price from Pyth...");
  const pythData = await buildPriceUpdateInstructions(provider.connection);

  // Max SOL cost for slippage protection (1 SOL = 1e9 lamports)
  const maxSolCost = new anchor.BN(1_000_000_000);
  // No platform fee for direct registration
  const platformFeeBps = 0;

  const ix = await program.methods
    .registerSymbolSol(symbol, years, maxSolCost, platformFeeBps)
    .accountsPartial({
      payer: provider.wallet.publicKey,
      config: configPda,
      tokenAccount: tokenPda,
      tokenMint: mintPubkey,
      tokenMetadata: tokenMetadata,
      feeCollector: feeCollector,
      priceUpdate: pythData.priceUpdateAccount,
      platformFeeAccount: null,
    })
    .instruction();

  const transaction = new anchor.web3.Transaction();
  for (const preIx of pythData.preInstructions) transaction.add(preIx);
  transaction.add(ix);
  for (const closeIx of pythData.closeInstructions) transaction.add(closeIx);

  const tx = await provider.sendAndConfirm(transaction, pythData.ephemeralSigners as Keypair[]);

  console.log("\nSymbol registered!");
  console.log(`  Transaction: ${tx}`);
  console.log(`\nTo lookup: npx tsx app/demo.ts lookup ${symbol}`);
}

async function renewSymbol(symbol: string, years: number) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  // Get fee collector from config
  const config = await (program.account as any).config.fetch(configPda);
  const feeCollector = config.feeCollector;

  const tokenAccount = await (program.account as any).token.fetch(tokenPda);

  console.log("Renewing symbol with SOL...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Additional years: ${years}`);
  console.log(`  Current expiration: ${formatDate(tokenAccount.expiresAt.toNumber())}`);

  // Fetch Pyth price update from Hermes
  console.log("  Fetching SOL/USD price from Pyth...");
  const pythData = await buildPriceUpdateInstructions(provider.connection);

  // Max SOL cost for slippage protection (1 SOL = 1e9 lamports)
  const maxSolCost = new anchor.BN(1_000_000_000);
  // No platform fee for direct renewal
  const platformFeeBps = 0;

  const ix = await program.methods
    .renewSymbolSol(years, maxSolCost, platformFeeBps)
    .accountsPartial({
      payer: provider.wallet.publicKey,
      tokenAccount: tokenPda,
      feeCollector: feeCollector,
      priceUpdate: pythData.priceUpdateAccount,
      platformFeeAccount: null,
    })
    .instruction();

  const transaction = new anchor.web3.Transaction();
  for (const preIx of pythData.preInstructions) transaction.add(preIx);
  transaction.add(ix);
  for (const closeIx of pythData.closeInstructions) transaction.add(closeIx);

  const tx = await provider.sendAndConfirm(transaction, pythData.ephemeralSigners as Keypair[]);

  const tokenAccountAfter = await (program.account as any).token.fetch(tokenPda);

  console.log("\nSymbol renewed!");
  console.log(`  New expiration: ${formatDate(tokenAccountAfter.expiresAt.toNumber())}`);
  console.log(`  Transaction: ${tx}`);
}

async function updateMint(symbol: string, newMint: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const newMintPubkey = new PublicKey(newMint);
  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  const config = await (program.account as any).config.fetch(configPda);
  const tokenAccount = await (program.account as any).token.fetch(tokenPda);

  console.log("Updating mint with SOL payment...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Current mint: ${tokenAccount.mint}`);
  console.log(`  New mint: ${newMintPubkey}`);

  // Fetch Pyth price update from Hermes
  console.log("  Fetching SOL/USD price from Pyth...");
  const pythData = await buildPriceUpdateInstructions(provider.connection);

  // Max SOL cost for slippage protection (0.5 SOL for update fee)
  const maxSolCost = new anchor.BN(500_000_000);
  // No platform fee for direct update
  const platformFeeBps = 0;

  const ix = await program.methods
    .updateMintSol(maxSolCost, platformFeeBps)
    .accountsPartial({
      owner: provider.wallet.publicKey,
      tokenAccount: tokenPda,
      newMint: newMintPubkey,
      newMintMetadata: getMetadataPda(newMintPubkey),
      feeCollector: config.feeCollector,
      priceUpdate: pythData.priceUpdateAccount,
      platformFeeAccount: null,
    })
    .instruction();

  const transaction = new anchor.web3.Transaction();
  for (const preIx of pythData.preInstructions) transaction.add(preIx);
  transaction.add(ix);
  for (const closeIx of pythData.closeInstructions) transaction.add(closeIx);

  const tx = await provider.sendAndConfirm(transaction, pythData.ephemeralSigners as Keypair[]);

  console.log("\nMint updated!");
  console.log(`  Transaction: ${tx}`);
}

async function transferOwnership(symbol: string, newOwner: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const newOwnerPubkey = new PublicKey(newOwner);
  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  const tokenAccount = await (program.account as any).token.fetch(tokenPda);

  console.log("Transferring symbol ownership...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Current owner: ${tokenAccount.owner}`);
  console.log(`  New owner: ${newOwnerPubkey}`);

  const tx = await program.methods
    .transferOwnership(newOwnerPubkey)
    .accounts({
      owner: provider.wallet.publicKey,
      config: configPda,
      tokenAccount: tokenPda,
    })
    .rpc();

  console.log("\nOwnership transferred!");
  console.log(`  Transaction: ${tx}`);
}

async function cancelSymbol(symbol: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  const tokenAccount = await (program.account as any).token.fetch(tokenPda);

  console.log("Canceling symbol...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Owner: ${tokenAccount.owner}`);

  const tx = await program.methods
    .cancelSymbol()
    .accounts({
      keeper: provider.wallet.publicKey,
      config: configPda,
      tokenAccount: tokenPda,
    })
    .rpc();

  console.log("\nSymbol canceled! Rent returned to owner.");
  console.log(`  Transaction: ${tx}`);
}

async function verifyOrClose(symbol: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  // Check if symbol exists
  let tokenAccount;
  try {
    tokenAccount = await (program.account as any).token.fetch(tokenPda);
  } catch {
    console.log(`Symbol "${symbol}" not found.`);
    return;
  }

  const mintPubkey = tokenAccount.mint as PublicKey;

  // Check if Token-2022 mint to determine correct metadata account
  const mintAccountInfo = await provider.connection.getAccountInfo(mintPubkey);
  const isToken2022 = mintAccountInfo?.owner.equals(TOKEN_2022_PROGRAM_ID);

  // For Token-2022: pass mint as metadata (embedded metadata)
  // For classic SPL: pass Metaplex metadata PDA
  const tokenMetadata = isToken2022 ? mintPubkey : getMetadataPda(mintPubkey);

  console.log("Verifying symbol matches metadata...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Mint: ${tokenAccount.mint}`);
  console.log(`  Token Type: ${isToken2022 ? "Token-2022" : "Classic SPL"}`);
  console.log(`  Owner: ${tokenAccount.owner}`);

  try {
    const tx = await program.methods
      .verifyOrClose()
      .accountsPartial({
        keeper: provider.wallet.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
        tokenMint: mintPubkey,
        tokenMetadata: tokenMetadata,
      })
      .rpc();

    // If we get here, either symbol matched (no closure) or it was closed
    // Check if account still exists
    try {
      await (program.account as any).token.fetch(tokenPda);
      console.log("\nSymbol verified! Metadata matches.");
      console.log(`  Transaction: ${tx}`);
    } catch {
      console.log("\nSymbol DRIFTED! Account closed due to metadata mismatch.");
      console.log("  Rent returned to keeper as reward.");
      console.log(`  Transaction: ${tx}`);
    }
  } catch (err: any) {
    if (err.message?.includes("MetadataSymbolMismatch")) {
      console.log("\nSymbol drift detected but closure may have failed.");
    } else {
      throw err;
    }
  }
}

async function lookupSymbol(symbol: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const tokenPda = getTokenPda(symbol);

  try {
    const tokenAccount = await (program.account as any).token.fetch(tokenPda);
    const expiresAt = tokenAccount.expiresAt.toNumber();

    console.log(`\nSymbol: $${tokenAccount.symbol}`);
    console.log("─".repeat(50));
    console.log(`  PDA: ${tokenPda}`);
    console.log(`  Mint: ${tokenAccount.mint}`);
    console.log(`  Owner: ${tokenAccount.owner}`);
    console.log(`  Registered: ${formatDate(tokenAccount.registeredAt.toNumber())}`);
    console.log(`  Expires: ${formatDate(expiresAt)}`);
    console.log(`  Status: ${getSymbolStatus(expiresAt)}`);
  } catch (err: unknown) {
    const error = err as Error;
    if (error.message?.includes("Account does not exist")) {
      console.log(`\nSymbol ${symbol} is not registered.`);
      console.log(`  Register it: npx tsx app/demo.ts register ${symbol} <mint_address> <years>`);
    } else {
      throw err;
    }
  }
}

async function lookupByMint(mint: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const mintPubkey = new PublicKey(mint);

  console.log(`\nSearching for symbol with mint: ${mintPubkey}`);
  console.log("─".repeat(50));

  // Fetch all token accounts and find matching mint
  // Note: In production, use an indexer for efficient lookups
  const accounts = await (program.account as any).token.all();
  const match = accounts.find((a: any) => a.account.mint.equals(mintPubkey));

  if (match) {
    console.log(`  Found: $${match.account.symbol}`);
    console.log(`  PDA: ${match.publicKey}`);
    console.log(`  Owner: ${match.account.owner}`);
    console.log(`  Expires: ${formatDate(match.account.expiresAt.toNumber())}`);
  } else {
    console.log("  No symbol found for this mint.");
    console.log("  The token may not be registered in TNS.");
  }
}

function showPda(symbol: string) {
  const tokenPda = getTokenPda(symbol);
  console.log(`Symbol: ${symbol}`);
  console.log(`PDA: ${tokenPda}`);
}

// ============ Admin Commands ============

function getPhaseDescription(phase: number): string {
  switch (phase) {
    case 1: return "Genesis (admin-only)";
    case 2: return "Open (anyone can register, reserved tradfi still protected)";
    case 3: return "Full (all restrictions removed)";
    default: return `Unknown (${phase})`;
  }
}

async function showConfig() {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  try {
    const config = await (program.account as any).config.fetch(configPda);

    console.log("\nTNS Protocol Config");
    console.log("─".repeat(60));
    console.log(`  Config PDA:        ${configPda}`);
    console.log(`  Admin:             ${config.admin}`);
    console.log(`  Fee Collector:     ${config.feeCollector}`);
    console.log(`  SOL/USD Pyth Feed: ${config.solUsdPythFeed} (legacy, unused - now uses pull oracle)`);
    console.log(`  TNS/USD Pyth Feed: ${config.tnsUsdPythFeed || "None (not configured)"}`);
    console.log("");
    console.log(`  Paused:  ${config.paused ? "YES ⛔ (registrations blocked)" : "NO ✅ (accepting registrations)"}`);
    console.log(`  Phase:   ${config.phase} - ${getPhaseDescription(config.phase)}`);
    console.log("");
    console.log(`  Base Price:       $${(config.basePriceUsdMicro.toNumber() / 1_000_000).toFixed(2)}/year`);
    console.log(`  Annual Increase:  ${config.annualIncreaseBps / 100}%`);
    console.log(`  Update Fee:       ${config.updateFeeBps / 100}% of base price`);
    console.log(`  Keeper Reward:    ${config.keeperRewardLamports.toNumber() / 1_000_000_000} SOL`);
    console.log(`  Launch:           ${formatDate(config.launchTimestamp.toNumber())}`);
  } catch (err: unknown) {
    const error = err as Error;
    if (error.message?.includes("Account does not exist")) {
      console.log("\nConfig not initialized yet.");
      console.log("  Run: npx tsx app/demo.ts init");
    } else {
      throw err;
    }
  }
}

async function updateConfigPaused(paused: boolean) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  const config = await (program.account as any).config.fetch(configPda);

  if (config.paused === paused) {
    console.log(`\nProtocol is already ${paused ? "paused" : "unpaused"}.`);
    return;
  }

  console.log(`\n${paused ? "Pausing" : "Unpausing"} protocol...`);

  const tx = await program.methods
    .updateConfig(
      null, // new_fee_collector
      paused,
      null, // new_phase
      null, // tns_usd_pyth_feed
      null, // keeper_reward_lamports
    )
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      newAdmin: provider.wallet.publicKey, // keep same admin
    })
    .rpc();

  console.log(`\nProtocol ${paused ? "paused" : "unpaused"}!`);
  console.log(`  Transaction: ${tx}`);

  // Show updated config
  await showConfig();
}

async function setPhase(newPhase: number) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  const config = await (program.account as any).config.fetch(configPda);

  if (newPhase <= config.phase) {
    console.log(`\nError: Phase can only go forward. Current: ${config.phase}, requested: ${newPhase}`);
    console.log("  Phase transitions: 1 → 2 → 3 (cannot go backward)");
    return;
  }

  if (newPhase > 3) {
    console.log(`\nError: Maximum phase is 3.`);
    return;
  }

  console.log(`\nSetting phase ${config.phase} → ${newPhase}...`);
  console.log(`  ${getPhaseDescription(config.phase)}`);
  console.log(`  → ${getPhaseDescription(newPhase)}`);

  const tx = await program.methods
    .updateConfig(
      null, // new_fee_collector
      null, // paused
      newPhase,
      null, // tns_usd_pyth_feed
      null, // keeper_reward_lamports
    )
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      newAdmin: provider.wallet.publicKey, // keep same admin
    })
    .rpc();

  console.log(`\nPhase updated to ${newPhase}!`);
  console.log(`  Transaction: ${tx}`);

  // Show updated config
  await showConfig();
}

async function setKeeperReward(solAmount: number) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  const lamports = Math.floor(solAmount * 1_000_000_000);

  console.log(`\nSetting keeper reward to ${solAmount} SOL (${lamports} lamports)...`);

  const tx = await program.methods
    .updateConfig(
      null, // new_fee_collector
      null, // paused
      null, // new_phase
      null, // tns_usd_pyth_feed
      new anchor.BN(lamports),
    )
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      newAdmin: provider.wallet.publicKey,
    })
    .rpc();

  console.log(`\nKeeper reward updated!`);
  console.log(`  Transaction: ${tx}`);

  await showConfig();
}

async function setFeeCollector(feeCollector: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  const feeCollectorPubkey = new PublicKey(feeCollector);

  console.log(`\nSetting fee collector to ${feeCollector}...`);

  const tx = await program.methods
    .updateConfig(
      feeCollectorPubkey,
      null, // paused
      null, // new_phase
      null, // tns_usd_pyth_feed
      null, // keeper_reward_lamports
    )
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      newAdmin: provider.wallet.publicKey,
    })
    .rpc();

  console.log(`\nFee collector updated!`);
  console.log(`  Transaction: ${tx}`);

  await showConfig();
}

async function setTnsPythFeed(feed: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  const feedPubkey = new PublicKey(feed);

  console.log(`\nSetting TNS/USD Pyth feed to ${feed}...`);

  const tx = await program.methods
    .updateConfig(
      null, // new_fee_collector
      null, // paused
      null, // new_phase
      feedPubkey,
      null, // keeper_reward_lamports
    )
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      newAdmin: provider.wallet.publicKey,
    })
    .rpc();

  console.log(`\nTNS/USD Pyth feed updated!`);
  console.log(`  Transaction: ${tx}`);

  await showConfig();
}

async function seedSymbol(symbol: string, mint: string, owner: string, years: number = 2) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const mintPubkey = new PublicKey(mint);
  const ownerPubkey = new PublicKey(owner);
  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  // Check if symbol already exists
  try {
    const existing = await (program.account as any).token.fetch(tokenPda);
    console.log(`\nError: Symbol "${symbol}" is already registered.`);
    console.log(`  Owner: ${existing.owner}`);
    console.log(`  Mint: ${existing.mint}`);
    console.log(`  Expires: ${formatDate(existing.expiresAt.toNumber())}`);
    process.exit(1);
  } catch {
    // Account doesn't exist - good, we can seed
  }

  // Check if mint is Token-2022 (for metadata handling)
  const mintAccountInfo = await provider.connection.getAccountInfo(mintPubkey);
  const isToken2022 = mintAccountInfo?.owner.equals(TOKEN_2022_PROGRAM_ID);

  // For Token-2022, pass mint as metadata (metadata is embedded in mint)
  // For classic SPL tokens, use Metaplex metadata PDA
  const tokenMetadata = isToken2022 ? mintPubkey : getMetadataPda(mintPubkey);

  console.log("Seeding symbol (admin only, no fee)...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Token Mint: ${mintPubkey}`);
  console.log(`  Owner: ${ownerPubkey}`);
  console.log(`  Years: ${years}`);
  console.log(`  Token PDA: ${tokenPda}`);
  console.log(`  Token Type: ${isToken2022 ? "Token-2022" : "SPL Token"}`);

  const tx = await program.methods
    .seedSymbol(symbol, years, ownerPubkey)
    .accountsPartial({
      admin: provider.wallet.publicKey,
      config: configPda,
      tokenAccount: tokenPda,
      tokenMint: mintPubkey,
      tokenMetadata: tokenMetadata,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\nSymbol seeded!");
  console.log(`  Transaction: ${tx}`);
  console.log(`\nTo lookup: npx tsx app/demo.ts lookup ${symbol}`);
}

async function adminUpdateSymbol(
  symbol: string,
  newOwner?: string,
  newMint?: string,
  newExpiresAt?: number
) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  // Fetch current state
  const tokenAccount = await (program.account as any).token.fetch(tokenPda);

  console.log("Admin updating symbol...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Current owner: ${tokenAccount.owner}`);
  console.log(`  Current mint: ${tokenAccount.mint}`);
  console.log(`  Current expires: ${formatDate(tokenAccount.expiresAt.toNumber())}`);
  console.log("");

  if (newOwner) console.log(`  New owner: ${newOwner}`);
  if (newMint) console.log(`  New mint: ${newMint}`);
  if (newExpiresAt) console.log(`  New expires: ${formatDate(newExpiresAt)}`);

  const tx = await program.methods
    .adminUpdateSymbol(
      newOwner ? new PublicKey(newOwner) : null,
      newMint ? new PublicKey(newMint) : null,
      newExpiresAt ? new anchor.BN(newExpiresAt) : null
    )
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      tokenAccount: tokenPda,
    })
    .rpc();

  console.log("\nSymbol updated by admin!");
  console.log(`  Transaction: ${tx}`);
}

async function adminCloseSymbol(symbol: string) {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);

  const configPda = getConfigPda();
  const tokenPda = getTokenPda(symbol);

  // Fetch current state for display
  const tokenAccount = await (program.account as any).token.fetch(tokenPda);

  console.log("Admin closing symbol (force delete)...");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Current owner: ${tokenAccount.owner}`);
  console.log(`  Current mint: ${tokenAccount.mint}`);
  console.log(`  WARNING: This will permanently delete the symbol!`);

  const tx = await program.methods
    .adminCloseSymbol()
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      tokenAccount: tokenPda,
    })
    .rpc();

  console.log("\nSymbol closed by admin! Rent returned.");
  console.log(`  Transaction: ${tx}`);
  console.log(`\nThe symbol ${symbol} is now available for fresh registration.`);
}

async function createFeeCollectorAtas() {
  const provider = getProvider();
  anchor.setProvider(provider);
  const program = getProgram(provider);
  const configPda = getConfigPda();

  // Fetch fee collector from config
  const config = await (program.account as any).config.fetch(configPda);
  const feeCollector = config.feeCollector as PublicKey;

  console.log("Creating ATAs for fee collector...");
  console.log(`  Fee Collector: ${feeCollector}`);
  console.log(`  Payer: ${provider.wallet.publicKey}`);
  console.log("");

  const mints = [
    { name: "USDC", mint: USDC_MINT, programId: TOKEN_PROGRAM_ID },
    { name: "USDT", mint: USDT_MINT, programId: TOKEN_PROGRAM_ID },
    { name: "TNS", mint: TNS_MINT, programId: TOKEN_2022_PROGRAM_ID },
  ];

  const transaction = new anchor.web3.Transaction();
  const atasToCreate: { name: string; ata: PublicKey }[] = [];

  for (const { name, mint, programId } of mints) {
    const ata = getAssociatedTokenAddressSync(mint, feeCollector, false, programId);

    // Check if ATA already exists
    const accountInfo = await provider.connection.getAccountInfo(ata);

    if (accountInfo) {
      console.log(`  ${name} ATA: ${ata} (already exists)`);
    } else {
      console.log(`  ${name} ATA: ${ata} (will create)`);
      transaction.add(
        createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey, // payer
          ata, // ata address
          feeCollector, // owner
          mint, // mint
          programId, // token program
        )
      );
      atasToCreate.push({ name, ata });
    }
  }

  if (atasToCreate.length === 0) {
    console.log("\nAll ATAs already exist. Nothing to do.");
    return;
  }

  console.log(`\nCreating ${atasToCreate.length} ATA(s)...`);
  const tx = await provider.sendAndConfirm(transaction);

  console.log("\nATAs created successfully!");
  console.log(`  Transaction: ${tx}`);
  for (const { name, ata } of atasToCreate) {
    console.log(`  ${name}: ${ata}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case "init":
        await initConfig(args[1]); // optional fee collector pubkey
        break;

      case "create-atas":
        await createFeeCollectorAtas();
        break;

      case "register":
        if (args.length < 4) {
          console.log("Usage: npx tsx app/demo.ts register <symbol> <mint> <years>");
          console.log("Example: npx tsx app/demo.ts register Bonk DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 1");
          process.exit(1);
        }
        await registerSymbol(args[1], args[2], parseInt(args[3]));
        break;

      case "renew":
        if (args.length < 3) {
          console.log("Usage: npx tsx app/demo.ts renew <symbol> <years>");
          process.exit(1);
        }
        await renewSymbol(args[1], parseInt(args[2]));
        break;

      case "update-mint":
        if (args.length < 3) {
          console.log("Usage: npx tsx app/demo.ts update-mint <symbol> <new_mint>");
          process.exit(1);
        }
        await updateMint(args[1], args[2]);
        break;

      case "transfer":
        if (args.length < 3) {
          console.log("Usage: npx tsx app/demo.ts transfer <symbol> <new_owner>");
          process.exit(1);
        }
        await transferOwnership(args[1], args[2]);
        break;

      case "cancel":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts cancel <symbol>");
          process.exit(1);
        }
        await cancelSymbol(args[1]);
        break;

      case "verify":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts verify <symbol>");
          console.log("Checks if symbol still matches its mint's metadata.");
          console.log("If metadata symbol changed, closes account and returns rent to caller.");
          process.exit(1);
        }
        await verifyOrClose(args[1]);
        break;

      case "lookup":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts lookup <symbol>");
          process.exit(1);
        }
        await lookupSymbol(args[1]);
        break;

      case "lookup-mint":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts lookup-mint <mint_address>");
          process.exit(1);
        }
        await lookupByMint(args[1]);
        break;

      case "pda":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts pda <symbol>");
          process.exit(1);
        }
        showPda(args[1]);
        break;

      // Admin commands
      case "config":
        await showConfig();
        break;

      case "unpause":
        await updateConfigPaused(false);
        break;

      case "pause":
        await updateConfigPaused(true);
        break;

      case "set-phase":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts set-phase <phase>");
          console.log("  Phase 1: Genesis (admin-only)");
          console.log("  Phase 2: Open (anyone can register unseeded symbols)");
          console.log("  Phase 3: Full (all restrictions removed)");
          process.exit(1);
        }
        await setPhase(parseInt(args[1]));
        break;

      case "set-keeper-reward":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts set-keeper-reward <sol_amount>");
          console.log("Example: npx tsx app/demo.ts set-keeper-reward 0.05");
          process.exit(1);
        }
        await setKeeperReward(parseFloat(args[1]));
        break;

      case "set-fee-collector":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts set-fee-collector <pubkey>");
          console.log("Example: npx tsx app/demo.ts set-fee-collector TNS1pnrBBe5K7eUpm3bcd4nxnfupVK6EatmoYRfxpMm");
          process.exit(1);
        }
        await setFeeCollector(args[1]);
        break;

      case "set-tns-pyth-feed":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts set-tns-pyth-feed <pubkey>");
          console.log("Example: npx tsx app/demo.ts set-tns-pyth-feed <pyth_feed_address>");
          process.exit(1);
        }
        await setTnsPythFeed(args[1]);
        break;

      case "seed":
        if (args.length < 4) {
          console.log("Usage: npx tsx app/demo.ts seed <symbol> <mint> <owner> [years]");
          console.log("Example: npx tsx app/demo.ts seed BONK DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 OwnerPubkey123 2");
          process.exit(1);
        }
        await seedSymbol(args[1], args[2], args[3], args[4] ? parseInt(args[4]) : undefined);
        break;

      case "admin-update":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts admin-update <symbol> [--owner <pubkey>] [--mint <pubkey>] [--expires <timestamp>]");
          console.log("Example: npx tsx app/demo.ts admin-update Bonk --owner NewOwnerPubkey123");
          console.log("Example: npx tsx app/demo.ts admin-update Bonk --expires 1735689600");
          process.exit(1);
        }
        {
          const symbol = args[1];
          let newOwner: string | undefined;
          let newMint: string | undefined;
          let newExpires: number | undefined;

          for (let i = 2; i < args.length; i++) {
            if (args[i] === "--owner" && args[i + 1]) {
              newOwner = args[++i];
            } else if (args[i] === "--mint" && args[i + 1]) {
              newMint = args[++i];
            } else if (args[i] === "--expires" && args[i + 1]) {
              newExpires = parseInt(args[++i]);
            }
          }

          if (!newOwner && !newMint && !newExpires) {
            console.log("Error: Must specify at least one of --owner, --mint, or --expires");
            process.exit(1);
          }

          await adminUpdateSymbol(symbol, newOwner, newMint, newExpires);
        }
        break;

      case "admin-close":
        if (args.length < 2) {
          console.log("Usage: npx tsx app/demo.ts admin-close <symbol>");
          process.exit(1);
        }
        await adminCloseSymbol(args[1]);
        break;

      default:
        console.log("TNS (Token Naming Service) Demo CLI\n");
        console.log("User Commands:");
        console.log("  init [fee_collector]                     - Initialize config (starts PAUSED)");
        console.log("  create-atas                              - Create USDC/USDT/TNS ATAs for fee collector");
        console.log("  register <symbol> <mint> <years>         - Register a symbol (1-10 years, pays SOL)");
        console.log("  renew <symbol> <years>                   - Renew a symbol (pays SOL)");
        console.log("  update-mint <symbol> <new_mint>          - Update mint for a symbol (pays SOL)");
        console.log("  transfer <symbol> <new_owner>            - Transfer symbol ownership (free)");
        console.log("  cancel <symbol>                          - Cancel symbol and reclaim rent");
        console.log("  verify <symbol>                          - Verify symbol matches metadata (keeper)");
        console.log("  lookup <symbol>                          - Lookup symbol details");
        console.log("  lookup-mint <mint>                       - Reverse lookup by mint");
        console.log("  pda <symbol>                             - Derive token PDA address");
        console.log("\nAdmin Commands (requires admin wallet):");
        console.log("  config                                   - View current config state");
        console.log("  unpause                                  - Unpause protocol (allow registrations)");
        console.log("  pause                                    - Pause protocol (block registrations)");
        console.log("  set-phase <1|2|3>                        - Advance protocol phase");
        console.log("  set-keeper-reward <sol_amount>           - Set keeper reward (e.g., 0.05)");
        console.log("  set-fee-collector <pubkey>               - Set fee collector address");
        console.log("  set-tns-pyth-feed <pubkey>               - Set TNS/USD Pyth feed address");
        console.log("  seed <symbol> <mint> <owner> [years]     - Seed a symbol (free, default 2 years)");
        console.log("  admin-update <symbol> [options]          - Force-update owner/mint/expiration");
        console.log("    --owner <pubkey>                       - Set new owner");
        console.log("    --mint <pubkey>                        - Set new mint");
        console.log("    --expires <timestamp>                  - Set new expiration (unix timestamp)");
        console.log("  admin-close <symbol>                     - Force-close and delete a symbol");
        console.log("\nProtocol Phases:");
        console.log("  1 - Genesis: Admin-only, verified tokens seeded via admin scripts");
        console.log("  2 - Open:    Anyone can register unseeded symbols, reserved tradfi protected");
        console.log("  3 - Full:    All restrictions removed, anyone can register anything");
        console.log("\nPricing:");
        console.log("  Base price: ~$10/year (converted to SOL via Pyth oracle)");
        console.log("  Multi-year discounts: 5-25% for 2-10 years");
        console.log("  Pay with TNS token for 25% discount");
        console.log("  Also accepts USDC and USDT");
        console.log("\nExamples:");
        console.log("  npx tsx app/demo.ts init                     # Initialize (starts paused)");
        console.log("  npx tsx app/demo.ts config                   # Check current state");
        console.log("  npx tsx app/demo.ts seed Bonk DezXAZ...263   # Seed verified token (while paused)");
        console.log("  npx tsx app/demo.ts unpause                  # Go live");
        console.log("  npx tsx app/demo.ts register TEST ...mint... 5");
        console.log("  npx tsx app/demo.ts lookup Bonk");
        break;
    }
  } catch (err) {
    console.error("\nError:", err);
    process.exit(1);
  }
}

main();

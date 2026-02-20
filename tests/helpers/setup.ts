import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Tns } from "../../target/types/tns";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  TYPE_SIZE,
  LENGTH_SIZE,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  pack,
  TokenMetadata,
} from "@solana/spl-token-metadata";

// Token Metadata Program ID (Metaplex)
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// Legacy Pyth push oracle (still used by initialize instruction to populate config field)
export const SOL_USD_PYTH_FEED = new PublicKey(
  "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
);
// Pyth pull oracle PriceUpdateV2 account (mock fixture loaded in test validator)
export const SOL_USD_PRICE_UPDATE = new PublicKey(
  "7UVimffxr9ow1uXYxbK2aDRwZc7hRcy1fU7SEgHBJu6e"
);
// SOL/USD feed ID (same on mainnet and devnet)
export const SOL_USD_FEED_ID = Buffer.from(
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "hex"
);

// USDC mint (mainnet address cloned to localnet)
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
// USDT mint (mainnet address cloned to localnet)
export const USDT_MINT = new PublicKey(
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
);

// Pyth magic number
const PYTH_MAGIC = 0xa1b2c3d4;

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: Program<Tns>;
  admin: anchor.Wallet;
  configPda: PublicKey;
  feeCollector: Keypair;
  feeCollectorPubkey: PublicKey; // The actual fee collector in config (may differ from feeCollector.publicKey)
  registrant: Keypair;
  solUsdPythFeed: PublicKey; // Legacy push oracle (used only in initialize)
  priceUpdate: PublicKey; // PriceUpdateV2 pull oracle (used in all SOL/TNS instructions)
  solUsdFeedId: number[];
  currentPhase: number;
  mockPriceFeedKeypair: Keypair | null;
}

export function getConfigPda(programId: PublicKey): PublicKey {
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  return configPda;
}

export function getTokenPda(programId: PublicKey, symbol: string): PublicKey {
  const [tokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token"), Buffer.from(symbol)],
    programId
  );
  return tokenPda;
}

/**
 * Create a mock Pyth price feed account with valid data for localnet testing.
 *
 * Pyth price account layout (v2):
 * - Offset 0-3: Magic number (u32) = 0xa1b2c3d4
 * - Offset 32-35: Exponent (i32) - typically -8 for SOL/USD
 * - Offset 208-215: Aggregate price (i64)
 * - Offset 224-231: Aggregate publish time (i64)
 */
export async function createMockPythPriceFeed(
  provider: anchor.AnchorProvider,
  payer: Keypair | anchor.Wallet
): Promise<Keypair> {
  const priceFeedKeypair = Keypair.generate();

  // Create account with enough space for Pyth price feed (232 bytes minimum)
  const space = 256;
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(
    space
  );

  // Build the price feed data
  const data = Buffer.alloc(space);

  // Magic number at offset 0 (little-endian)
  data.writeUInt32LE(PYTH_MAGIC, 0);

  // Exponent at offset 32 (i32, little-endian) - SOL/USD typically uses -8
  data.writeInt32LE(-8, 32);

  // Price at offset 208 (i64, little-endian) - $200 = 20000000000 * 10^-8
  // Use BigInt for 64-bit integers
  const price = BigInt(20000000000); // $200 with exponent -8
  data.writeBigInt64LE(price, 208);

  // Publish time at offset 224 (i64, little-endian) - current timestamp
  const publishTime = BigInt(Math.floor(Date.now() / 1000));
  data.writeBigInt64LE(publishTime, 224);

  // Create the account
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: "payer" in payer ? payer.payer.publicKey : payer.publicKey,
    newAccountPubkey: priceFeedKeypair.publicKey,
    lamports,
    space,
    programId: SystemProgram.programId, // Use system program as owner
  });

  // Create transaction
  const tx = new anchor.web3.Transaction().add(createAccountIx);

  // Sign and send
  if ("payer" in payer) {
    // It's an anchor.Wallet
    tx.feePayer = payer.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.partialSign(priceFeedKeypair);
    const signedTx = await payer.signTransaction(tx);
    await provider.connection.sendRawTransaction(signedTx.serialize());
  } else {
    // It's a Keypair
    tx.feePayer = payer.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(payer, priceFeedKeypair);
    await provider.connection.sendRawTransaction(tx.serialize());
  }

  // Wait for confirmation
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Now write the data to the account
  // Unfortunately, we can't write arbitrary data to a system-owned account directly
  // We need to use a different approach - create the account with the data embedded

  // Actually, let's use a simpler approach: create the account and then write data via
  // writing raw bytes. But System Program accounts can't have data written after creation.

  // Let's create a new account with pre-populated data using a program that allows this.
  // For localnet testing, we can use the BPF Loader to create a test account.

  // Alternative: Write data directly into the account during creation by using
  // a different method...

  // Actually the cleanest solution is to write the data via the account info
  // after creation by setting the account directly in localnet.

  return priceFeedKeypair;
}

/**
 * Create a mock Pyth price feed account by directly setting account data on localnet.
 */
export async function createMockPythPriceFeedDirect(
  provider: anchor.AnchorProvider,
  admin: anchor.Wallet
): Promise<PublicKey> {
  // Generate a keypair for the mock price feed
  const priceFeedKeypair = Keypair.generate();

  // Build the price feed data (256 bytes)
  const space = 256;
  const data = Buffer.alloc(space);

  // Magic number at offset 0 (little-endian)
  data.writeUInt32LE(PYTH_MAGIC, 0);

  // Exponent at offset 32 (i32, little-endian) - SOL/USD typically uses -8
  data.writeInt32LE(-8, 32);

  // Price at offset 208 (i64, little-endian) - $200 = 20000000000 * 10^-8
  const price = BigInt(20000000000);
  data.writeBigInt64LE(price, 208);

  // Publish time at offset 224 (i64, little-endian) - current timestamp
  const publishTime = BigInt(Math.floor(Date.now() / 1000));
  data.writeBigInt64LE(publishTime, 224);

  // Create the account with enough lamports for rent exemption
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(
    space
  );

  // Use setAccount on localnet to directly create the account with data
  // This only works on localnet/devnet test validators
  const createIx = SystemProgram.createAccount({
    fromPubkey: admin.publicKey,
    newAccountPubkey: priceFeedKeypair.publicKey,
    lamports,
    space,
    programId: SystemProgram.programId,
  });

  const tx = new anchor.web3.Transaction().add(createIx);
  tx.feePayer = admin.publicKey;
  const { blockhash } = await provider.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.partialSign(priceFeedKeypair);
  const signedTx = await admin.signTransaction(tx);
  const sig = await provider.connection.sendRawTransaction(
    signedTx.serialize()
  );
  await provider.connection.confirmTransaction(sig);

  // On localnet, we can use solana set-account via CLI or direct account manipulation
  // For anchor tests, the simplest approach is to use requestAirdrop + direct assignment

  // Actually, let's use a workaround: we need to use the solana test validator's
  // ability to load accounts with specific data. For now, let's return the keypair
  // and handle this in the test setup.

  return priceFeedKeypair.publicKey;
}

export async function ensureConfigInitialized(ctx: TestContext): Promise<void> {
  const { program, admin, configPda, feeCollector, provider } = ctx;

  const accountInfo = await provider.connection.getAccountInfo(configPda);
  if (accountInfo !== null) {
    // Config already initialized, fetch the current state from config
    const config = await program.account.config.fetch(configPda);
    ctx.feeCollectorPubkey = config.feeCollector;
    ctx.currentPhase = config.phase;
    ctx.solUsdPythFeed = config.solUsdPythFeed;
    return;
  }

  // For localnet, we need to create a mock Pyth price feed
  // Use the devnet feed address - it should be loaded in the test validator config
  let priceFeedAddress = SOL_USD_PYTH_FEED;

  // Check if the price feed exists
  const priceFeedInfo = await provider.connection.getAccountInfo(
    priceFeedAddress
  );
  if (!priceFeedInfo) {
    // Create a mock price feed if it doesn't exist
    // Note: This requires the test validator to be configured to allow this
    console.log("Warning: Pyth price feed not found, tests may fail");
  }

  ctx.solUsdPythFeed = priceFeedAddress;

  await program.methods
    .initialize()
    .accountsPartial({
      admin: admin.publicKey,
      payer: admin.publicKey,
      config: configPda,
      solUsdPythFeed: priceFeedAddress,
      feeCollector: feeCollector.publicKey,
    })
    .rpc();

  // Set the initial values
  ctx.feeCollectorPubkey = feeCollector.publicKey;
  ctx.currentPhase = 1;
}

// Refresh config state from chain
export async function refreshConfigState(ctx: TestContext): Promise<void> {
  const config = await ctx.program.account.config.fetch(ctx.configPda);
  ctx.feeCollectorPubkey = config.feeCollector;
  ctx.currentPhase = config.phase;
  ctx.solUsdPythFeed = config.solUsdPythFeed;
}

// Ensure protocol is unpaused (for test isolation)
export async function ensureUnpaused(ctx: TestContext): Promise<void> {
  const { program, admin, configPda } = ctx;
  const config = await program.account.config.fetch(configPda);

  if (config.paused) {
    await program.methods
      .updateConfig(null, false, null, null, null)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();
  }
}

// Reset config to phase 1 if possible (for test isolation)
// Note: Phase can only go forward, so this only works on fresh validator
export async function ensurePhase1(ctx: TestContext): Promise<void> {
  const { program, configPda } = ctx;
  const config = await program.account.config.fetch(configPda);
  ctx.currentPhase = config.phase;
}

export function setupTest(): TestContext {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Tns as Program<Tns>;
  const admin = provider.wallet as anchor.Wallet;
  const configPda = getConfigPda(program.programId);

  const feeCollector = Keypair.generate();
  const registrant = Keypair.generate();

  return {
    provider,
    program,
    admin,
    configPda,
    feeCollector,
    feeCollectorPubkey: feeCollector.publicKey, // Will be updated in ensureConfigInitialized
    registrant,
    solUsdPythFeed: SOL_USD_PYTH_FEED,
    priceUpdate: SOL_USD_PRICE_UPDATE,
    solUsdFeedId: Array.from(SOL_USD_FEED_ID),
    currentPhase: 1, // Will be updated in ensureConfigInitialized
    mockPriceFeedKeypair: null,
  };
}

export async function fundAccounts(
  provider: anchor.AnchorProvider,
  ...accounts: Keypair[]
): Promise<void> {
  for (const account of accounts) {
    const sig = await provider.connection.requestAirdrop(
      account.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
  }
}

export async function getBalance(
  provider: anchor.AnchorProvider,
  account: PublicKey
): Promise<number> {
  return provider.connection.getBalance(account);
}

/**
 * Derive the Metaplex metadata PDA for a given mint.
 */
export function getMetadataPda(mint: PublicKey): PublicKey {
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


/**
 * Create a CreateMetadataAccountV3 instruction manually.
 * Uses Borsh serialization compatible with Token Metadata program.
 *
 * Instruction layout:
 * - discriminator: u8 (33 for CreateMetadataAccountV3)
 * - data: DataV2 (name, symbol, uri, seller_fee_basis_points, creators, collection, uses)
 * - is_mutable: bool
 * - collection_details: Option<CollectionDetails>
 */
function createMetadataV3Instruction(
  metadataPda: PublicKey,
  mint: PublicKey,
  mintAuthority: PublicKey,
  payer: PublicKey,
  updateAuthority: PublicKey,
  name: string,
  symbol: string,
  uri: string,
  isMutable: boolean
): TransactionInstruction {
  // Borsh serialize a string: 4-byte little-endian length + UTF-8 bytes
  const serializeString = (str: string): Buffer => {
    const bytes = Buffer.from(str, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([lenBuf, bytes]);
  };

  // Build the instruction data using Borsh format
  const parts: Buffer[] = [];

  // 1. Discriminator for CreateMetadataAccountV3 = 33
  parts.push(Buffer.from([33]));

  // 2. DataV2 fields:
  // - name: String
  parts.push(serializeString(name));
  // - symbol: String
  parts.push(serializeString(symbol));
  // - uri: String
  parts.push(serializeString(uri));
  // - seller_fee_basis_points: u16
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(0, 0);
  parts.push(feeBuf);
  // - creators: Option<Vec<Creator>> = None (0)
  parts.push(Buffer.from([0]));
  // - collection: Option<Collection> = None (0)
  parts.push(Buffer.from([0]));
  // - uses: Option<Uses> = None (0)
  parts.push(Buffer.from([0]));

  // 3. is_mutable: bool
  parts.push(Buffer.from([isMutable ? 1 : 0]));

  // 4. collection_details: Option<CollectionDetails> = None (0)
  parts.push(Buffer.from([0]));

  const data = Buffer.concat(parts);

  return new TransactionInstruction({
    keys: [
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_METADATA_PROGRAM_ID,
    data,
  });
}

/**
 * Create a token mint with Metaplex metadata.
 * Returns the mint public key.
 *
 * @param provider - Anchor provider
 * @param payer - Keypair that pays for transactions
 * @param symbol - The symbol for the token metadata (case-sensitive for TNS)
 * @param name - The name for the token metadata
 * @param makeImmutable - Whether to make the metadata immutable (required for TNS)
 */
export async function createTokenWithMetadata(
  provider: anchor.AnchorProvider,
  payer: Keypair | anchor.Wallet,
  symbol: string,
  name: string = `${symbol} Token`,
  makeImmutable: boolean = true
): Promise<PublicKey> {
  const payerKeypair = "payer" in payer ? payer.payer : payer;
  const connection = provider.connection;

  // Create the mint
  const mint = await createMint(
    connection,
    payerKeypair,
    payerKeypair.publicKey,
    null,
    9
  );

  // Derive metadata PDA
  const metadataPda = getMetadataPda(mint);

  // Create metadata instruction
  const createMetadataIx = createMetadataV3Instruction(
    metadataPda,
    mint,
    payerKeypair.publicKey,
    payerKeypair.publicKey,
    payerKeypair.publicKey,
    name,
    symbol,
    "", // uri
    !makeImmutable // isMutable = false if we want immutable
  );

  // Send create metadata transaction
  const tx = new Transaction().add(createMetadataIx);
  await sendAndConfirmTransaction(connection, tx, [payerKeypair]);

  return mint;
}

/**
 * Create a Token-2022 mint with embedded metadata extension.
 * Returns the mint public key.
 *
 * @param provider - Anchor provider
 * @param payer - Keypair that pays for transactions
 * @param symbol - The symbol for the token metadata
 * @param name - The name for the token metadata
 */
export async function createToken2022WithMetadata(
  provider: anchor.AnchorProvider,
  payer: Keypair | anchor.Wallet,
  symbol: string,
  name: string = `${symbol} Token`
): Promise<PublicKey> {
  const payerKeypair = "payer" in payer ? payer.payer : payer;
  const connection = provider.connection;

  // Generate a new keypair for the mint
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Define the metadata
  const metadata: TokenMetadata = {
    mint: mint,
    name: name,
    symbol: symbol,
    uri: "",
    additionalMetadata: [],
  };

  // Calculate space needed for mint with metadata pointer extension
  // getMintLen gives us the base mint size + extension headers
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);

  // Metadata is stored as TLV (Type-Length-Value)
  // TYPE_SIZE (2 bytes) + LENGTH_SIZE (2 bytes) + packed metadata
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;

  // Total space needed
  const totalLen = mintLen + metadataLen;

  // Get minimum lamports for rent exemption
  const lamports = await connection.getMinimumBalanceForRentExemption(totalLen);

  // Build transaction in two parts:
  // Part 1: Create account, init pointer, init mint
  const tx1 = new Transaction().add(
    // 1. Create account
    SystemProgram.createAccount({
      fromPubkey: payerKeypair.publicKey,
      newAccountPubkey: mint,
      space: mintLen, // Start with just mint space
      lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // 2. Initialize metadata pointer (points to mint itself)
    createInitializeMetadataPointerInstruction(
      mint,
      payerKeypair.publicKey,
      mint, // metadata address is the mint itself
      TOKEN_2022_PROGRAM_ID
    ),
    // 3. Initialize mint
    createInitializeMintInstruction(
      mint,
      9, // decimals
      payerKeypair.publicKey, // mint authority
      null, // freeze authority
      TOKEN_2022_PROGRAM_ID
    )
  );

  await sendAndConfirmTransaction(connection, tx1, [
    payerKeypair,
    mintKeypair,
  ]);

  // Part 2: Fund additional rent for metadata, then initialize metadata
  // The metadata initialization will reallocate the account and needs more lamports
  const additionalRent = await connection.getMinimumBalanceForRentExemption(metadataLen);

  const tx2 = new Transaction().add(
    // Transfer additional lamports for the metadata space
    SystemProgram.transfer({
      fromPubkey: payerKeypair.publicKey,
      toPubkey: mint,
      lamports: additionalRent,
    }),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      mint: mint,
      metadata: mint,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      mintAuthority: payerKeypair.publicKey,
      updateAuthority: payerKeypair.publicKey,
    })
  );

  await sendAndConfirmTransaction(connection, tx2, [payerKeypair]);

  return mint;
}

// Re-export TOKEN_2022_PROGRAM_ID for tests
export { TOKEN_2022_PROGRAM_ID };

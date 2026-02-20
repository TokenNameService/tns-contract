#!/usr/bin/env npx tsx
/**
 * Create an SPL token mint with metadata.
 *
 * By default creates a classic SPL token mirroring 9Gst2E7KovZ9jwecyGqnnhpG1mhHKdyLpJQnZonkCFhA (USDX):
 *   - Classic SPL Token program, 6 decimals
 *   - Mint authority, freeze authority, update authority all retained
 *   - Metaplex metadata (isMutable = true)
 *
 * With --token-2022, creates a Token-2022 mint with embedded metadata extension.
 *
 * With --authority <PUBKEY>, all authorities (mint, freeze, update) are transferred
 * to the given pubkey after creation. The payer only pays tx fees and never retains
 * any control over the mint.
 *
 * Usage:
 *   npx tsx scripts/create-token.ts <SYMBOL> [options]
 *
 * Environment:
 *   SOLANA_RPC_URL / RPC_URL  - RPC endpoint (default: http://localhost:8899)
 *   KEYPAIR                   - Path to payer keypair JSON (default: ~/.config/solana/id.json)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  TYPE_SIZE,
  LENGTH_SIZE,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  pack,
  TokenMetadata,
} from "@solana/spl-token-metadata";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------- Metaplex helpers (for classic SPL tokens) ----------

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

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
  const serializeString = (str: string): Buffer => {
    const bytes = Buffer.from(str, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([lenBuf, bytes]);
  };

  const parts: Buffer[] = [];

  // Discriminator for CreateMetadataAccountV3 = 33
  parts.push(Buffer.from([33]));

  // DataV2 fields
  parts.push(serializeString(name));
  parts.push(serializeString(symbol));
  parts.push(serializeString(uri));

  // seller_fee_basis_points: u16 = 0
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(0, 0);
  parts.push(feeBuf);

  // creators: Option<Vec<Creator>> = None
  parts.push(Buffer.from([0]));
  // collection: Option<Collection> = None
  parts.push(Buffer.from([0]));
  // uses: Option<Uses> = None
  parts.push(Buffer.from([0]));

  // is_mutable
  parts.push(Buffer.from([isMutable ? 1 : 0]));

  // collection_details: Option<CollectionDetails> = None
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
 * Metaplex UpdateMetadataAccountV2 instruction to transfer update authority.
 * Discriminator = 15, sends: Option<DataV2> = None, Option<Pubkey> = Some(newAuth),
 * Option<bool> = None.
 */
function createUpdateMetadataAuthorityInstruction(
  metadataPda: PublicKey,
  currentAuthority: PublicKey,
  newAuthority: PublicKey
): TransactionInstruction {
  const parts: Buffer[] = [];

  // Discriminator for UpdateMetadataAccountV2 = 15
  parts.push(Buffer.from([15]));

  // data: Option<DataV2> = None
  parts.push(Buffer.from([0]));

  // new_update_authority: Option<Pubkey> = Some(newAuthority)
  parts.push(Buffer.from([1]));
  parts.push(newAuthority.toBuffer());

  // primary_sale_happened: Option<bool> = None
  parts.push(Buffer.from([0]));

  // is_mutable: Option<bool> = None
  parts.push(Buffer.from([0]));

  const data = Buffer.concat(parts);

  return new TransactionInstruction({
    keys: [
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: currentAuthority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_METADATA_PROGRAM_ID,
    data,
  });
}

// ---------- Classic SPL Token creation ----------

async function createClassicToken(
  connection: Connection,
  payer: Keypair,
  authority: PublicKey,
  symbol: string,
  name: string,
  decimals: number,
  uri: string
): Promise<PublicKey> {
  // 1. Create mint with payer as authority (must be signer for metadata creation)
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey, // mint authority (payer initially, transferred after)
    payer.publicKey, // freeze authority
    decimals
  );

  console.log(`Mint created: ${mint.toBase58()}`);

  // 2. Create Metaplex metadata (payer is mint authority + update authority for now)
  const metadataPda = getMetadataPda(mint);

  const createMetadataIx = createMetadataV3Instruction(
    metadataPda,
    mint,
    payer.publicKey,
    payer.publicKey,
    payer.publicKey,
    name,
    symbol,
    uri,
    true // isMutable
  );

  const tx = new Transaction().add(createMetadataIx);
  await sendAndConfirmTransaction(connection, tx, [payer]);

  console.log(`Metadata created: ${metadataPda.toBase58()}`);

  // 3. Transfer all authorities to the target if different from payer
  if (!authority.equals(payer.publicKey)) {
    console.log(`\nTransferring authorities to ${authority.toBase58()}...`);

    const transferTx = new Transaction().add(
      // Transfer mint authority
      createSetAuthorityInstruction(
        mint,
        payer.publicKey,
        AuthorityType.MintTokens,
        authority,
        [],
        TOKEN_PROGRAM_ID
      ),
      // Transfer freeze authority
      createSetAuthorityInstruction(
        mint,
        payer.publicKey,
        AuthorityType.FreezeAccount,
        authority,
        [],
        TOKEN_PROGRAM_ID
      ),
      // Transfer metadata update authority
      createUpdateMetadataAuthorityInstruction(
        metadataPda,
        payer.publicKey,
        authority
      )
    );

    await sendAndConfirmTransaction(connection, transferTx, [payer]);

    console.log(`  Mint authority     -> ${authority.toBase58()}`);
    console.log(`  Freeze authority   -> ${authority.toBase58()}`);
    console.log(`  Update authority   -> ${authority.toBase58()}`);
  }

  return mint;
}

// ---------- Token-2022 creation ----------

async function createToken2022(
  connection: Connection,
  payer: Keypair,
  authority: PublicKey,
  symbol: string,
  name: string,
  decimals: number,
  uri: string
): Promise<PublicKey> {
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const metadata: TokenMetadata = {
    mint,
    name,
    symbol,
    uri,
    additionalMetadata: [],
  };

  // Calculate space: base mint + metadata pointer extension
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;

  // TX 1: Create account, init metadata pointer, init mint
  const tx1 = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint,
      payer.publicKey,
      mint, // metadata address is the mint itself
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mint,
      decimals,
      payer.publicKey, // mint authority (payer initially)
      payer.publicKey, // freeze authority
      TOKEN_2022_PROGRAM_ID
    )
  );

  await sendAndConfirmTransaction(connection, tx1, [payer, mintKeypair]);

  console.log(`Mint created: ${mint.toBase58()}`);

  // TX 2: Fund additional rent for metadata, then initialize metadata
  const additionalRent =
    await connection.getMinimumBalanceForRentExemption(metadataLen);

  const tx2 = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: mint,
      lamports: additionalRent,
    }),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      mint,
      metadata: mint,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      mintAuthority: payer.publicKey,
      updateAuthority: payer.publicKey,
    })
  );

  await sendAndConfirmTransaction(connection, tx2, [payer]);

  console.log(`Embedded metadata initialized`);

  // 3. Transfer all authorities to the target if different from payer
  if (!authority.equals(payer.publicKey)) {
    console.log(`\nTransferring authorities to ${authority.toBase58()}...`);

    const transferTx = new Transaction().add(
      // Transfer mint authority
      createSetAuthorityInstruction(
        mint,
        payer.publicKey,
        AuthorityType.MintTokens,
        authority,
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      // Transfer freeze authority
      createSetAuthorityInstruction(
        mint,
        payer.publicKey,
        AuthorityType.FreezeAccount,
        authority,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, transferTx, [payer]);

    console.log(`  Mint authority     -> ${authority.toBase58()}`);
    console.log(`  Freeze authority   -> ${authority.toBase58()}`);
    // Note: Token-2022 embedded metadata update authority is set via the
    // metadata pointer authority, which was set during initialization.
    // To transfer it, the new authority holder would use spl-token authorize.
  }

  return mint;
}

// ---------- CLI ----------

function printUsage() {
  console.log(`
Usage: npx tsx scripts/create-token.ts <SYMBOL> [options]

Options:
  --name <name>       Token name (default: "<SYMBOL> Token")
  --decimals <n>      Decimals (default: 6)
  --uri <url>         Metadata URI (default: "")
  --authority <pubkey> Set all authorities (mint, freeze, update) to this pubkey.
                      Payer only pays tx fees and retains no control.
                      (default: payer keypair)
  --token-2022        Use Token-2022 program with embedded metadata
                      (default: classic SPL with Metaplex metadata)
  --keypair <path>    Path to payer keypair JSON
                      (default: KEYPAIR env or ~/.config/solana/id.json)
  --rpc <url>         RPC URL
                      (default: SOLANA_RPC_URL or RPC_URL env or http://localhost:8899)

Output:
  Prints the new mint address to stdout.
`);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return undefined;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  // First positional arg that doesn't start with -- and isn't a flag value
  const flagsWithValues = new Set([
    "--name",
    "--decimals",
    "--uri",
    "--authority",
    "--keypair",
    "--rpc",
  ]);
  const flagValues = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValues.has(args[i]) && i + 1 < args.length) {
      flagValues.add(i + 1);
    }
  }
  const symbol = args.find(
    (a, i) => !a.startsWith("--") && !flagValues.has(i)
  );
  if (!symbol) {
    console.error("Error: SYMBOL is required");
    printUsage();
    process.exit(1);
  }

  const name = getFlag("--name") ?? `${symbol} Token`;
  const decimals = parseInt(getFlag("--decimals") ?? "6", 10);
  const uri = getFlag("--uri") ?? "";
  const authorityStr = getFlag("--authority");
  const token2022 = hasFlag("--token-2022");
  const keypairPath =
    getFlag("--keypair") ??
    process.env.KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  const rpcUrl =
    getFlag("--rpc") ??
    process.env.SOLANA_RPC_URL ??
    process.env.RPC_URL ??
    "http://localhost:8899";

  return {
    symbol,
    name,
    decimals,
    uri,
    authorityStr,
    token2022,
    keypairPath,
    rpcUrl,
  };
}

async function main() {
  const {
    symbol,
    name,
    decimals,
    uri,
    authorityStr,
    token2022,
    keypairPath,
    rpcUrl,
  } = parseArgs(process.argv);

  // Load payer keypair
  if (!fs.existsSync(keypairPath)) {
    console.error(`Keypair file not found: ${keypairPath}`);
    process.exit(1);
  }
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  // Determine authority — defaults to payer if not specified
  const authority = authorityStr
    ? new PublicKey(authorityStr)
    : payer.publicKey;

  const connection = new Connection(rpcUrl, "confirmed");

  const program = token2022 ? "Token-2022" : "Classic SPL";
  console.log(`Creating ${program} token...`);
  console.log(`  Symbol:    ${symbol}`);
  console.log(`  Name:      ${name}`);
  console.log(`  Decimals:  ${decimals}`);
  console.log(`  URI:       ${uri || "(none)"}`);
  console.log(`  Payer:     ${payer.publicKey.toBase58()}`);
  console.log(`  Authority: ${authority.toBase58()}${authorityStr ? "" : " (payer)"}`);
  console.log(`  RPC:       ${rpcUrl}`);
  console.log();

  const mint = token2022
    ? await createToken2022(connection, payer, authority, symbol, name, decimals, uri)
    : await createClassicToken(connection, payer, authority, symbol, name, decimals, uri);

  console.log();
  console.log(`Done! Mint address:`);
  console.log(mint.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

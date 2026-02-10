import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { expect } from "chai";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  fundAccounts,
  getTokenPda,
  getConfigPda,
  getBalance,
  refreshConfigState,
  ensureUnpaused,
  createTokenWithMetadata,
  getMetadataPda,
  TOKEN_METADATA_PROGRAM_ID,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

/**
 * Create metadata instruction for testing
 */
function createMetadataV3Ix(
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
  parts.push(Buffer.from([33]));
  parts.push(serializeString(name));
  parts.push(serializeString(symbol));
  parts.push(serializeString(uri));
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(0, 0);
  parts.push(feeBuf);
  parts.push(Buffer.from([0]));
  parts.push(Buffer.from([0]));
  parts.push(Buffer.from([0]));
  parts.push(Buffer.from([isMutable ? 1 : 0]));
  parts.push(Buffer.from([0]));

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
    data: Buffer.concat(parts),
  });
}

/**
 * Create UpdateMetadataAccountV2 instruction for testing drift
 */
function updateMetadataV2Ix(
  metadataPda: PublicKey,
  updateAuthority: PublicKey,
  newName: string | null,
  newSymbol: string | null,
  newUri: string | null
): TransactionInstruction {
  const serializeString = (str: string): Buffer => {
    const bytes = Buffer.from(str, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([lenBuf, bytes]);
  };

  const parts: Buffer[] = [];
  parts.push(Buffer.from([15])); // UpdateMetadataAccountV2 discriminator

  if (newName !== null || newSymbol !== null || newUri !== null) {
    parts.push(Buffer.from([1])); // Some
    parts.push(serializeString(newName || ""));
    parts.push(serializeString(newSymbol || ""));
    parts.push(serializeString(newUri || ""));
    const feeBuf = Buffer.alloc(2);
    feeBuf.writeUInt16LE(0, 0);
    parts.push(feeBuf);
    parts.push(Buffer.from([0]));
    parts.push(Buffer.from([0]));
    parts.push(Buffer.from([0]));
  } else {
    parts.push(Buffer.from([0]));
  }

  parts.push(Buffer.from([0])); // new_update_authority: None
  parts.push(Buffer.from([0])); // primary_sale_happened: None
  parts.push(Buffer.from([0])); // is_mutable: None

  return new TransactionInstruction({
    keys: [
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: updateAuthority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_METADATA_PROGRAM_ID,
    data: Buffer.concat(parts),
  });
}

describe("TNS - Verify Or Close", () => {
  let ctx: TestContext;
  const tokenMints: Map<string, PublicKey> = new Map();

  async function getOrCreateTokenMint(
    symbol: string,
    _mutable: boolean = false // Currently not used - all tokens created as immutable
  ): Promise<PublicKey> {
    // Note: For now, always create immutable tokens for test compatibility
    // The verify_or_close instruction doesn't require immutability
    const key = `${symbol}-immutable`;
    if (tokenMints.has(key)) {
      return tokenMints.get(key)!;
    }
    const mint = await createTokenWithMetadata(
      ctx.provider,
      ctx.admin,
      symbol,
      `${symbol} Token`,
      true // makeImmutable = true
    );
    tokenMints.set(key, mint);
    return mint;
  }

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);
    await refreshConfigState(ctx);
    await ensureUnpaused(ctx);
  });

  describe("Metadata Verification", () => {
    it("fails with NoDriftDetected when symbol matches metadata", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Register a symbol first
      const symbol = "VERIFY1";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol, true); // mutable metadata
      const tokenMetadata = getMetadataPda(tokenMint);

      // Register the symbol
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();

      // Verify the token account exists
      const tokenAccountBefore = await program.account.token.fetch(tokenPda);
      expect(tokenAccountBefore.symbol).to.equal(symbol);

      // Call verify_or_close - should FAIL because no drift detected
      try {
        await program.methods
          .verifyOrClose()
          .accountsPartial({
            keeper: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMetadata: tokenMetadata,
          })
          .rpc();

        expect.fail("Should have thrown NoDriftDetected error");
      } catch (err: any) {
        expect(err.message).to.include("NoDriftDetected");
      }

      // Token account should still exist (instruction failed)
      const tokenAccountAfter = await program.account.token.fetch(tokenPda);
      expect(tokenAccountAfter.symbol).to.equal(symbol);
    });

    it("anyone can call verify_or_close (fails if no drift)", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Register a symbol
      const symbol = "VERIFY2";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol, true);
      const tokenMetadata = getMetadataPda(tokenMint);

      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();

      // Non-owner can call verify_or_close (but it fails since no drift)
      const randomKeeper = Keypair.generate();
      await fundAccounts(ctx.provider, randomKeeper);

      try {
        await program.methods
          .verifyOrClose()
          .accountsPartial({
            keeper: randomKeeper.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMetadata: tokenMetadata,
          })
          .signers([randomKeeper])
          .rpc();

        expect.fail("Should have thrown NoDriftDetected error");
      } catch (err: any) {
        // Instruction is permissionless but fails when no drift
        expect(err.message).to.include("NoDriftDetected");
      }

      // Token account should still exist (instruction failed)
      const tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal(symbol);
    });

    it("fails with invalid metadata account", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Register a symbol
      const symbol = "VERIFY3";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol, true);
      const tokenMetadata = getMetadataPda(tokenMint);

      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();

      // Try to verify with wrong metadata account
      const wrongMint = await getOrCreateTokenMint("WRONG", true);
      const wrongMetadata = getMetadataPda(wrongMint);

      try {
        await program.methods
          .verifyOrClose()
          .accountsPartial({
            keeper: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMetadata: wrongMetadata, // Wrong metadata!
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err: any) {
        expect(err.message).to.include("InvalidMetadata");
      }
    });

    it("successfully closes symbol when metadata drift is detected", async () => {
      const { program, configPda } = ctx;

      const symbol = "DRIFT";
      const mintAuthority = Keypair.generate();
      const keeper = Keypair.generate();
      await fundAccounts(ctx.provider, mintAuthority, keeper);

      // Create mint with controlled authority (mutable metadata)
      const tokenMint = await createMint(
        ctx.provider.connection,
        mintAuthority,
        mintAuthority.publicKey,
        null,
        9
      );

      const tokenMetadata = getMetadataPda(tokenMint);
      const tokenPda = getTokenPda(program.programId, symbol);

      // Create MUTABLE metadata
      const createMetadataIx = createMetadataV3Ix(
        tokenMetadata,
        tokenMint,
        mintAuthority.publicKey,
        mintAuthority.publicKey,
        mintAuthority.publicKey,
        `${symbol} Token`,
        symbol,
        "",
        true // MUTABLE
      );

      const createTx = new anchor.web3.Transaction().add(createMetadataIx);
      await anchor.web3.sendAndConfirmTransaction(ctx.provider.connection, createTx, [mintAuthority]);

      // Register the symbol
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          solUsdPriceFeed: ctx.solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();

      // Update metadata to create drift (change symbol)
      const updateMetadataIx = updateMetadataV2Ix(
        tokenMetadata,
        mintAuthority.publicKey,
        `${symbol} Token`,
        "DRIFTED", // Changed!
        ""
      );

      const updateTx = new anchor.web3.Transaction().add(updateMetadataIx);
      await anchor.web3.sendAndConfirmTransaction(ctx.provider.connection, updateTx, [mintAuthority]);

      // Verify token exists before
      const tokenBefore = await program.account.token.fetch(tokenPda);
      expect(tokenBefore.symbol).to.equal(symbol);

      const keeperBalanceBefore = await getBalance(ctx.provider, keeper.publicKey);

      // Now verify_or_close should succeed because drift detected
      await program.methods
        .verifyOrClose()
        .accountsPartial({
          keeper: keeper.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMetadata: tokenMetadata,
        })
        .signers([keeper])
        .rpc();

      // Verify token account is closed
      const tokenAccountInfo = await ctx.provider.connection.getAccountInfo(tokenPda);
      expect(tokenAccountInfo).to.be.null;

      // Verify keeper received rent
      const keeperBalanceAfter = await getBalance(ctx.provider, keeper.publicKey);
      expect(keeperBalanceAfter).to.be.greaterThan(keeperBalanceBefore);
    });
  });
});

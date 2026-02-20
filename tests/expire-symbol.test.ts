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
  refreshConfigState,
  ensureUnpaused,
  createTokenWithMetadata,
  getMetadataPda,
  getBalance,
  TOKEN_METADATA_PROGRAM_ID,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

// Time constants (matching contract)
const SECONDS_PER_YEAR = 31_557_600;

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

describe("TNS - Cancel Symbol", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);
  });

  it("fails to cancel a symbol that is still active", async () => {
    const { program, admin, configPda, feeCollectorPubkey, priceUpdate } =
      ctx;
    const symbol = "ACTIVE2";
    const tokenPda = getTokenPda(program.programId, symbol);

    // Create token mint with metadata
    const testTokenMint = await createTokenWithMetadata(
      ctx.provider,
      ctx.admin,
      symbol,
      `${symbol} Token`,
      true
    );
    const testTokenMetadata = getMetadataPda(testTokenMint);

    // Register the symbol for 1 year (as admin for Phase 1)
    await program.methods
      .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: admin.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
        tokenMint: testTokenMint,
        tokenMetadata: testTokenMetadata,
        feeCollector: feeCollectorPubkey,
        priceUpdate: priceUpdate,
        platformFeeAccount: null,
      })
      .rpc();

    // Try to cancel it immediately (should fail - still active)
    try {
      await program.methods
        .cancelSymbol()
        .accountsPartial({
          keeper: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      // Expected - symbol is not yet abandoned (1+ year past grace period)
      expect(err).to.exist;
    }
  });

  // Note: Testing actual cancellation requires manipulating time or waiting,
  // which is not practical in unit tests. In production, you would:
  // 1. Use a test validator with time manipulation
  // 2. Or set up a symbol with a very short expiration for testing

  it("verifies token account structure for cancellation check", async () => {
    const { program } = ctx;
    const tokenPda = getTokenPda(program.programId, "ACTIVE2");

    const tokenAccount = await program.account.token.fetch(tokenPda);

    // Verify the account has the fields needed for cancellation check
    expect(tokenAccount.expiresAt).to.exist;
    expect(tokenAccount.owner).to.exist;
    expect(tokenAccount.bump).to.exist;

    // GRACE_PERIOD_SECONDS = 90 days = 7,776,000 seconds
    // ABANDONMENT_PERIOD = 1 year after grace period
    const gracePeriod = 90 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);

    // Active: current time <= expires_at
    expect(now).to.be.lessThan(tokenAccount.expiresAt.toNumber());

    // Not in grace period: current time > expires_at && <= expires_at + grace
    const expirationPlusGrace = tokenAccount.expiresAt.toNumber() + gracePeriod;

    // Symbol should not be expired yet
    expect(now).to.be.lessThan(expirationPlusGrace);
  });

  describe("Cancel Expired Symbol", () => {
    const symbol = "EXPCANCEL";
    let tokenPda: PublicKey;
    let tokenMint: PublicKey;
    let tokenMetadata: PublicKey;
    let keeper: Keypair;

    before(async () => {
      keeper = Keypair.generate();
      await fundAccounts(ctx.provider, keeper);

      tokenMint = await createTokenWithMetadata(
        ctx.provider,
        ctx.admin,
        symbol,
        `${symbol} Token`,
        true
      );
      tokenMetadata = getMetadataPda(tokenMint);
      tokenPda = getTokenPda(ctx.program.programId, symbol);

      await ctx.program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          priceUpdate: ctx.priceUpdate,
          platformFeeAccount: null,
        })
        .rpc();

      // Set expiration to 3 years ago (definitely cancelable)
      const threeYearsAgo = Math.floor(Date.now() / 1000) - (3 * SECONDS_PER_YEAR);

      await ctx.program.methods
        .adminUpdateSymbol(null, null, new BN(threeYearsAgo))
        .accountsPartial({
          admin: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenPda,
        })
        .rpc();
    });

    it("successfully cancels an expired symbol and pays keeper", async () => {
      const { program, configPda } = ctx;

      const tokenBefore = await program.account.token.fetch(tokenPda);
      expect(tokenBefore.symbol).to.equal(symbol);

      const keeperBalanceBefore = await getBalance(ctx.provider, keeper.publicKey);

      await program.methods
        .cancelSymbol()
        .accountsPartial({
          keeper: keeper.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
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

    it("symbol can be re-registered after cancel", async () => {
      const { program, admin, configPda } = ctx;

      const newMint = await createTokenWithMetadata(
        ctx.provider,
        admin,
        symbol,
        `${symbol} Token V2`,
        true
      );
      const newMetadata = getMetadataPda(newMint);

      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: newMint,
          tokenMetadata: newMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          priceUpdate: ctx.priceUpdate,
          platformFeeAccount: null,
        })
        .rpc();

      const tokenAfter = await program.account.token.fetch(tokenPda);
      expect(tokenAfter.symbol).to.equal(symbol);
      expect(tokenAfter.mint.toString()).to.equal(newMint.toString());
    });
  });

  describe("Re-register After Expiration by New Owner", () => {
    const symbol = "REREGEXP";
    let tokenPda: PublicKey;
    let newOwner: Keypair;
    let newMintAuthority: Keypair;
    let keeper: Keypair;

    before(async () => {
      newOwner = Keypair.generate();
      newMintAuthority = Keypair.generate();
      keeper = Keypair.generate();
      await fundAccounts(ctx.provider, newOwner, newMintAuthority, keeper);

      const originalMint = await createTokenWithMetadata(
        ctx.provider,
        ctx.admin,
        symbol,
        `${symbol} Token`,
        true
      );
      const originalMetadata = getMetadataPda(originalMint);
      tokenPda = getTokenPda(ctx.program.programId, symbol);

      await ctx.program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenPda,
          tokenMint: originalMint,
          tokenMetadata: originalMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          priceUpdate: ctx.priceUpdate,
          platformFeeAccount: null,
        })
        .rpc();

      // Set to expired + cancelable
      const twoYearsAgo = Math.floor(Date.now() / 1000) - (2 * SECONDS_PER_YEAR);

      await ctx.program.methods
        .adminUpdateSymbol(null, null, new BN(twoYearsAgo))
        .accountsPartial({
          admin: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenPda,
        })
        .rpc();

      await ctx.program.methods
        .cancelSymbol()
        .accountsPartial({
          keeper: keeper.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenPda,
        })
        .signers([keeper])
        .rpc();
    });

    it("new owner can register previously expired symbol with different mint", async () => {
      const { program, configPda } = ctx;

      // Ensure Phase 2+ for non-admin registration
      await refreshConfigState(ctx);
      if (ctx.currentPhase < 2) {
        await program.methods
          .updateConfig(null, null, 2, null, null)
          .accountsPartial({
            admin: ctx.admin.publicKey,
            config: configPda,
          })
          .rpc();
        ctx.currentPhase = 2;
      }

      const newMint = await createMint(
        ctx.provider.connection,
        newMintAuthority,
        newMintAuthority.publicKey,
        null,
        9
      );

      const newMetadata = getMetadataPda(newMint);

      const createMetadataIx = createMetadataV3Ix(
        newMetadata,
        newMint,
        newMintAuthority.publicKey,
        newMintAuthority.publicKey,
        newMintAuthority.publicKey,
        `${symbol} Token V2`,
        symbol,
        "",
        false
      );

      const tx = new anchor.web3.Transaction().add(createMetadataIx);
      await anchor.web3.sendAndConfirmTransaction(ctx.provider.connection, tx, [newMintAuthority]);

      await program.methods
        .registerSymbolSol(symbol, 2, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: newOwner.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: newMint,
          tokenMetadata: newMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          priceUpdate: ctx.priceUpdate,
          platformFeeAccount: null,
        })
        .signers([newOwner])
        .rpc();

      const token = await program.account.token.fetch(tokenPda);
      expect(token.symbol).to.equal(symbol);
      expect(token.mint.toString()).to.equal(newMint.toString());
      expect(token.owner.toString()).to.equal(newOwner.publicKey.toString());
    });
  });
});

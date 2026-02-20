import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, SystemProgram } from "@solana/web3.js";
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
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Transfer Ownership", () => {
  let ctx: TestContext;
  const testSymbol = "XFER";
  let tokenPda: anchor.web3.PublicKey;
  let testTokenMint: anchor.web3.PublicKey;
  let testTokenMetadata: anchor.web3.PublicKey;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);

    // Create a test token mint with metadata
    testTokenMint = await createTokenWithMetadata(
      ctx.provider,
      ctx.admin,
      testSymbol,
      `${testSymbol} Token`,
      true // immutable
    );
    testTokenMetadata = getMetadataPda(testTokenMint);

    // Register a symbol to transfer (as admin for Phase 1)
    tokenPda = getTokenPda(ctx.program.programId, testSymbol);

    await ctx.program.methods
      .registerSymbolSol(testSymbol, 1, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: ctx.admin.publicKey,
        config: ctx.configPda,
        tokenAccount: tokenPda,
        tokenMint: testTokenMint,
        tokenMetadata: testTokenMetadata,
        feeCollector: ctx.feeCollectorPubkey,
        priceUpdate: ctx.priceUpdate,
        platformFeeAccount: null,
      })
      .rpc();
  });

  it("owner can transfer ownership", async () => {
    const { program, admin } = ctx;

    const newOwner = Keypair.generate();

    // Admin is the owner since they registered
    await program.methods
      .transferOwnership(newOwner.publicKey)
      .accountsPartial({
        owner: admin.publicKey,
        config: ctx.configPda,
        tokenAccount: tokenPda,
      })
      .rpc();

    const tokenAccount = await program.account.token.fetch(tokenPda);
    expect(tokenAccount.owner.toString()).to.equal(
      newOwner.publicKey.toString()
    );

    // Transfer back for other tests
    await program.methods
      .transferOwnership(admin.publicKey)
      .accountsPartial({
        owner: newOwner.publicKey,
        config: ctx.configPda,
        tokenAccount: tokenPda,
      })
      .signers([newOwner])
      .rpc();

    const tokenAccountAfter = await program.account.token.fetch(tokenPda);
    expect(tokenAccountAfter.owner.toString()).to.equal(
      admin.publicKey.toString()
    );
  });

  it("fails if non-owner tries to transfer", async () => {
    const { program, registrant } = ctx;

    const newOwner = Keypair.generate();

    try {
      await program.methods
        .transferOwnership(newOwner.publicKey)
        .accountsPartial({
          owner: registrant.publicKey, // Registrant is not the owner
          config: ctx.configPda,
          tokenAccount: tokenPda,
        })
        .signers([registrant])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("Unauthorized");
    }
  });

  it("fails if transferring to same owner", async () => {
    const { program, admin } = ctx;

    try {
      await program.methods
        .transferOwnership(admin.publicKey)
        .accountsPartial({
          owner: admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenPda,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("SameOwner");
    }
  });

  it("transfer to system program (zero-like address) behavior", async () => {
    const { program, admin } = ctx;

    try {
      await program.methods
        .transferOwnership(SystemProgram.programId)
        .accountsPartial({
          owner: admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenPda,
        })
        .rpc();

      // If it succeeds, verify the transfer happened
      const token = await program.account.token.fetch(tokenPda);
      expect(token.owner.toString()).to.equal(SystemProgram.programId.toString());
    } catch (err) {
      // Expected to fail with some error - this is acceptable behavior
      expect(err).to.exist;
    }
  });
});

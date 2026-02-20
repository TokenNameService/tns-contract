import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  fundAccounts,
  getTokenPda,
  getBalance,
  refreshConfigState,
  ensureUnpaused,
  createTokenWithMetadata,
  getMetadataPda,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Renew Symbol", () => {
  let ctx: TestContext;
  const testSymbol = "RENEW";
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

    // Register a symbol to renew (as admin since Phase 1 is admin-only)
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

  it("renews a symbol for additional years", async () => {
    const { program, admin, configPda, feeCollectorPubkey, priceUpdate } =
      ctx;

    const tokenBefore = await program.account.token.fetch(tokenPda);
    const expirationBefore = tokenBefore.expiresAt.toNumber();
    const feeCollectorBalanceBefore = await getBalance(
      ctx.provider,
      feeCollectorPubkey
    );

    await program.methods
      .renewSymbolSol(2, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: admin.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
        feeCollector: feeCollectorPubkey,
        priceUpdate: priceUpdate,
        platformFeeAccount: null,
      })
      .rpc();

    const tokenAfter = await program.account.token.fetch(tokenPda);

    // Verify expiration extended by 2 years
    const twoYears = 2 * 31_557_600;
    expect(tokenAfter.expiresAt.toNumber()).to.be.closeTo(
      expirationBefore + twoYears,
      60
    );

    // Verify fee was paid (no keeper reward for renewals)
    const feeCollectorBalanceAfter = await getBalance(
      ctx.provider,
      feeCollectorPubkey
    );
    expect(feeCollectorBalanceAfter).to.be.greaterThan(
      feeCollectorBalanceBefore
    );
  });

  it("anyone can renew for anyone", async () => {
    const {
      program,
      registrant,
      configPda,
      feeCollectorPubkey,
      priceUpdate,
    } = ctx;

    // Use registrant (different from owner) to renew
    const tokenBefore = await program.account.token.fetch(tokenPda);
    const expirationBefore = tokenBefore.expiresAt.toNumber();

    await program.methods
      .renewSymbolSol(1, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: registrant.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
        feeCollector: feeCollectorPubkey,
        priceUpdate: priceUpdate,
        platformFeeAccount: null,
      })
      .signers([registrant])
      .rpc();

    const tokenAfter = await program.account.token.fetch(tokenPda);
    const oneYear = 31_557_600;
    expect(tokenAfter.expiresAt.toNumber()).to.be.closeTo(
      expirationBefore + oneYear,
      60
    );
  });

  it("fails if renewal exceeds 10 years from now", async () => {
    const { program, admin, configPda, feeCollectorPubkey, priceUpdate } =
      ctx;

    // Symbol currently has multiple years, try to add too many more
    try {
      await program.methods
        .renewSymbolSol(10, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          priceUpdate: priceUpdate,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("ExceedsMaxYears");
    }
  });

  it("fails with invalid years (0)", async () => {
    const { program, admin, configPda, feeCollectorPubkey, priceUpdate } =
      ctx;

    try {
      await program.methods
        .renewSymbolSol(0, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          priceUpdate: priceUpdate,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("InvalidYears");
    }
  });

  describe("Grace Period Renewal", () => {
    const graceSymbol = "RENEWEXP";
    let graceTokenPda: anchor.web3.PublicKey;
    let graceTokenMint: anchor.web3.PublicKey;
    let graceTokenMetadata: anchor.web3.PublicKey;

    before(async () => {
      graceTokenMint = await createTokenWithMetadata(
        ctx.provider,
        ctx.admin,
        graceSymbol,
        `${graceSymbol} Token`,
        true
      );
      graceTokenMetadata = getMetadataPda(graceTokenMint);
      graceTokenPda = getTokenPda(ctx.program.programId, graceSymbol);

      await ctx.program.methods
        .registerSymbolSol(graceSymbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: graceTokenPda,
          tokenMint: graceTokenMint,
          tokenMetadata: graceTokenMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          priceUpdate: ctx.priceUpdate,
          platformFeeAccount: null,
        })
        .rpc();
    });

    it("can renew symbol that is in grace period", async () => {
      const { program, admin, configPda, feeCollectorPubkey, priceUpdate } = ctx;

      // Set to grace period (just expired but not past grace)
      const currentTime = Math.floor(Date.now() / 1000);
      const graceTime = currentTime - 1; // Just expired

      await program.methods
        .adminUpdateSymbol(null, null, new BN(graceTime))
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: graceTokenPda,
        })
        .rpc();

      // Verify it's in grace period
      const tokenBefore = await program.account.token.fetch(graceTokenPda);
      expect(Number(tokenBefore.expiresAt)).to.be.lessThan(currentTime);

      // Renew should still work during grace period
      await program.methods
        .renewSymbolSol(1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: graceTokenPda,
          feeCollector: feeCollectorPubkey,
          priceUpdate: priceUpdate,
          platformFeeAccount: null,
        })
        .rpc();

      const tokenAfter = await program.account.token.fetch(graceTokenPda);
      expect(Number(tokenAfter.expiresAt)).to.be.greaterThan(currentTime);
    });
  });
});

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { createMint } from "@solana/spl-token";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  fundAccounts,
  getTokenPda,
  getBalance,
  refreshConfigState,
  ensureUnpaused,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Renew Symbol", () => {
  let ctx: TestContext;
  const testSymbol = "RENEW";
  let tokenPda: anchor.web3.PublicKey;
  let testTokenMint: anchor.web3.PublicKey;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);

    // Create a test token mint
    testTokenMint = await createMint(
      ctx.provider.connection,
      ctx.admin.payer,
      ctx.admin.publicKey,
      null,
      9
    );

    // Register a symbol to renew (as admin since Phase 1 requires admin for non-whitelisted)
    tokenPda = getTokenPda(ctx.program.programId, testSymbol);

    await ctx.program.methods
      .registerSymbolSol(testSymbol, 1, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: ctx.admin.publicKey,
        config: ctx.configPda,
        tokenAccount: tokenPda,
        tokenMint: testTokenMint,
        feeCollector: ctx.feeCollectorPubkey,
        solUsdPriceFeed: ctx.solUsdPythFeed,
        platformFeeAccount: null,
      })
      .rpc();
  });

  it("renews a symbol for additional years", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
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
        solUsdPriceFeed: solUsdPythFeed,
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
      solUsdPythFeed,
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
        solUsdPriceFeed: solUsdPythFeed,
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
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;

    // Symbol currently has multiple years, try to add too many more
    try {
      await program.methods
        .renewSymbolSol(10, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("RenewalExceedsMaxYears");
    }
  });

  it("fails with invalid years (0)", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;

    try {
      await program.methods
        .renewSymbolSol(0, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("InvalidYears");
    }
  });
});

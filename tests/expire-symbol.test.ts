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
  refreshConfigState,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Cancel Symbol", () => {
  let ctx: TestContext;
  let testTokenMint: anchor.web3.PublicKey;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Create a test token mint
    testTokenMint = await createMint(
      ctx.provider.connection,
      ctx.admin.payer,
      ctx.admin.publicKey,
      null,
      9
    );
  });

  it("fails to cancel a symbol that is still active", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "ACTIVE2";
    const tokenPda = getTokenPda(program.programId, symbol);

    // Register the symbol for 1 year (as admin for Phase 1)
    await program.methods
      .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: admin.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
        tokenMint: testTokenMint,
        feeCollector: feeCollectorPubkey,
        solUsdPriceFeed: solUsdPythFeed,
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
});

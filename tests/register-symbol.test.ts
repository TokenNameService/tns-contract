import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair } from "@solana/web3.js";
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
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Register Symbol", () => {
  let ctx: TestContext;
  let testTokenMint: anchor.web3.PublicKey;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state (fee collector may have changed from other tests)
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

  it("registers a new symbol for 1 year", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "TEST1"; // Non-whitelisted symbol
    const tokenPda = getTokenPda(program.programId, symbol);

    const feeCollectorBalanceBefore = await getBalance(
      ctx.provider,
      feeCollectorPubkey
    );

    // In Phase 1, only admin can register non-whitelisted symbols
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

    const tokenAccount = await program.account.token.fetch(tokenPda);

    expect(tokenAccount.symbol).to.equal(symbol.toUpperCase());
    expect(tokenAccount.mint.toString()).to.equal(testTokenMint.toString());
    expect(tokenAccount.owner.toString()).to.equal(admin.publicKey.toString());

    // Verify expiration is ~1 year from now
    const now = Math.floor(Date.now() / 1000);
    const oneYear = 31_557_600; // seconds in a year
    expect(tokenAccount.expiresAt.toNumber()).to.be.closeTo(now + oneYear, 60);

    // Verify fee was paid
    const feeCollectorBalanceAfter = await getBalance(
      ctx.provider,
      feeCollectorPubkey
    );
    expect(feeCollectorBalanceAfter).to.be.greaterThan(
      feeCollectorBalanceBefore
    );
  });

  it("registers a symbol for 5 years with discount", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "TEST5"; // Non-whitelisted symbol
    const tokenPda = getTokenPda(program.programId, symbol);

    await program.methods
      .registerSymbolSol(symbol, 5, MAX_SOL_COST, 0)
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

    const tokenAccount = await program.account.token.fetch(tokenPda);

    // Verify expiration is ~5 years from now
    const now = Math.floor(Date.now() / 1000);
    const fiveYears = 5 * 31_557_600;
    expect(tokenAccount.expiresAt.toNumber()).to.be.closeTo(
      now + fiveYears,
      60
    );
  });

  it("normalizes symbol to uppercase", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "testlc"; // lowercase input (non-whitelisted)
    const tokenPda = getTokenPda(program.programId, "TESTLC"); // uppercase in PDA

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

    const tokenAccount = await program.account.token.fetch(tokenPda);
    expect(tokenAccount.symbol).to.equal("TESTLC");
  });

  it("fails to register an already registered symbol", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "TEST1"; // Already registered above
    const tokenPda = getTokenPda(program.programId, symbol);

    try {
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: testTokenMint,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      // Expected - symbol already exists
      expect(err).to.exist;
    }
  });

  it("fails with invalid years (0)", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "ZERO";
    const tokenPda = getTokenPda(program.programId, symbol);

    try {
      await program.methods
        .registerSymbolSol(symbol, 0, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: testTokenMint,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("InvalidYears");
    }
  });

  it("fails with invalid years (>10)", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "ELEVEN";
    const tokenPda = getTokenPda(program.programId, symbol);

    try {
      await program.methods
        .registerSymbolSol(symbol, 11, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: testTokenMint,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("InvalidYears");
    }
  });

  it("fails with empty symbol", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "";
    const tokenPda = getTokenPda(program.programId, symbol);

    try {
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: testTokenMint,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err).to.exist;
    }
  });

  it("fails with symbol too long", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "TOOLONGSYMBOL"; // > 10 chars
    const tokenPda = getTokenPda(program.programId, symbol);

    try {
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: testTokenMint,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err).to.exist;
    }
  });
});

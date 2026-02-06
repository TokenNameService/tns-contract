import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair } from "@solana/web3.js";
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

describe("TNS - Register Symbol", () => {
  let ctx: TestContext;
  // Store mints for each symbol
  const tokenMints: Map<string, anchor.web3.PublicKey> = new Map();

  // Helper to get or create a token mint with matching metadata
  async function getOrCreateTokenMint(symbol: string): Promise<anchor.web3.PublicKey> {
    if (tokenMints.has(symbol)) {
      return tokenMints.get(symbol)!;
    }
    const mint = await createTokenWithMetadata(
      ctx.provider,
      ctx.admin,
      symbol,
      `${symbol} Token`,
      true // immutable
    );
    tokenMints.set(symbol, mint);
    return mint;
  }

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state (fee collector may have changed from other tests)
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);
  });

  it("registers a new symbol for 1 year", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "TEST1"; // Non-whitelisted symbol
    const tokenPda = getTokenPda(program.programId, symbol);
    const tokenMint = await getOrCreateTokenMint(symbol);
    const tokenMetadata = getMetadataPda(tokenMint);

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
        tokenMint: tokenMint,
        tokenMetadata: tokenMetadata,
        feeCollector: feeCollectorPubkey,
        solUsdPriceFeed: solUsdPythFeed,
        platformFeeAccount: null,
      })
      .rpc();

    const tokenAccount = await program.account.token.fetch(tokenPda);

    expect(tokenAccount.symbol).to.equal(symbol);
    expect(tokenAccount.mint.toString()).to.equal(tokenMint.toString());
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
    const tokenMint = await getOrCreateTokenMint(symbol);
    const tokenMetadata = getMetadataPda(tokenMint);

    await program.methods
      .registerSymbolSol(symbol, 5, MAX_SOL_COST, 0)
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

    const tokenAccount = await program.account.token.fetch(tokenPda);

    // Verify expiration is ~5 years from now
    const now = Math.floor(Date.now() / 1000);
    const fiveYears = 5 * 31_557_600;
    expect(tokenAccount.expiresAt.toNumber()).to.be.closeTo(
      now + fiveYears,
      60
    );
  });

  it("rejects lowercase symbols", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    // Try to register "lowercase" - should be rejected
    const lowerSymbol = "lowercase";
    const lowerTokenPda = getTokenPda(program.programId, lowerSymbol);
    const lowerTokenMint = await getOrCreateTokenMint(lowerSymbol);
    const lowerTokenMetadata = getMetadataPda(lowerTokenMint);

    try {
      await program.methods
        .registerSymbolSol(lowerSymbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: lowerTokenPda,
          tokenMint: lowerTokenMint,
          tokenMetadata: lowerTokenMetadata,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();
      expect.fail("Should have rejected lowercase symbol");
    } catch (err: any) {
      expect(err.message).to.include("SymbolMustBeUppercase");
    }
  });

  it("fails to register an already registered symbol", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "TEST1"; // Already registered above
    const tokenPda = getTokenPda(program.programId, symbol);
    const tokenMint = await getOrCreateTokenMint(symbol);
    const tokenMetadata = getMetadataPda(tokenMint);

    try {
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
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
    const tokenMint = await getOrCreateTokenMint(symbol);
    const tokenMetadata = getMetadataPda(tokenMint);

    try {
      await program.methods
        .registerSymbolSol(symbol, 0, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
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
    const tokenMint = await getOrCreateTokenMint(symbol);
    const tokenMetadata = getMetadataPda(tokenMint);

    try {
      await program.methods
        .registerSymbolSol(symbol, 11, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("ExceedsMaxYears");
    }
  });

  it("fails with empty symbol", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;
    const symbol = "";
    const tokenPda = getTokenPda(program.programId, symbol);
    // Use any existing token for this test (will fail on symbol validation before metadata)
    const tokenMint = await getOrCreateTokenMint("EMPTY");
    const tokenMetadata = getMetadataPda(tokenMint);

    try {
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
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
    // Use any existing token for this test (will fail on symbol validation before metadata)
    const tokenMint = await getOrCreateTokenMint("TOOLONG");
    const tokenMetadata = getMetadataPda(tokenMint);

    try {
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
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

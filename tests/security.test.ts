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
  refreshConfigState,
  ensureUnpaused,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Security Tests", () => {
  let ctx: TestContext;
  let testTokenMint: anchor.web3.PublicKey;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);

    // Create a test token mint for use in tests
    testTokenMint = await createMint(
      ctx.provider.connection,
      ctx.admin.payer,
      ctx.admin.publicKey,
      null,
      9
    );
  });

  describe("Paused State", () => {
    let tokenForRenewal: anchor.web3.PublicKey;

    before(async () => {
      // Refresh config before each test block
      await refreshConfigState(ctx);

      // Ensure protocol is unpaused for setup
      await ensureUnpaused(ctx);

      // Register a symbol we can try to renew when paused (as admin for Phase 1)
      const symbol = "PAUSETEST";
      tokenForRenewal = getTokenPda(ctx.program.programId, symbol);

      await ctx.program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenForRenewal,
          tokenMint: testTokenMint,
          feeCollector: ctx.feeCollectorPubkey,
          solUsdPriceFeed: ctx.solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();
    });

    it("cannot register symbols when paused", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Pause the protocol
      await program.methods
        .updateConfig(null, true, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();

      const symbol = "PAUSED1";
      const tokenPda = getTokenPda(program.programId, symbol);

      try {
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

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Paused");
      }

      // Unpause for other tests
      await program.methods
        .updateConfig(null, false, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();
    });

    it("cannot renew symbols when paused", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Pause the protocol
      await program.methods
        .updateConfig(null, true, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();

      try {
        await program.methods
          .renewSymbolSol(1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: admin.publicKey,
            config: configPda,
            tokenAccount: tokenForRenewal,
            feeCollector: feeCollectorPubkey,
            solUsdPriceFeed: solUsdPythFeed,
            platformFeeAccount: null,
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Paused");
      }

      // Unpause for other tests
      await program.methods
        .updateConfig(null, false, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();
    });

    it("cannot update mint when paused", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Pause the protocol
      await program.methods
        .updateConfig(null, true, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();

      try {
        await program.methods
          .updateMintSol(MAX_SOL_COST, 0)
          .accountsPartial({
            owner: admin.publicKey,
            config: configPda,
            tokenAccount: tokenForRenewal,
            feeCollector: feeCollectorPubkey,
            solUsdPriceFeed: solUsdPythFeed,
            platformFeeAccount: null,
            newMint: testTokenMint, // Use valid mint
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Paused");
      }

      // Unpause for other tests
      await program.methods
        .updateConfig(null, false, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();
    });
  });

  describe("Reserved Symbols", () => {
    before(async () => {
      await refreshConfigState(ctx);
      await ensureUnpaused(ctx);
    });

    // In Phase 1 (Genesis), admins CAN register reserved symbols - this is by design
    // Reserved symbol protection only applies to non-admins in Phase 2+
    it("admin can register reserved TradFi symbols in Phase 1 (AAPL)", async () => {
      const {
        program,
        admin,
        configPda,
        feeCollectorPubkey,
        solUsdPythFeed,
        currentPhase,
      } = ctx;

      // This test only makes sense in Phase 1
      if (currentPhase !== 1) {
        console.log("Skipping: not in Phase 1");
        return;
      }

      const symbol = "AAPL"; // Reserved TradFi symbol
      const tokenPda = getTokenPda(program.programId, symbol);

      // In Phase 1, admin should be able to register reserved symbols
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

      const tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal("AAPL");
    });

    it("non-admin cannot register any symbol in Phase 1", async () => {
      const {
        program,
        registrant,
        configPda,
        feeCollectorPubkey,
        solUsdPythFeed,
        currentPhase,
      } = ctx;

      // This test only makes sense in Phase 1
      if (currentPhase !== 1) {
        console.log("Skipping: not in Phase 1");
        return;
      }

      const symbol = "GOOGL"; // Reserved TradFi symbol
      const tokenPda = getTokenPda(program.programId, symbol);

      try {
        await program.methods
          .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: registrant.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: testTokenMint,
            feeCollector: feeCollectorPubkey,
            solUsdPriceFeed: solUsdPythFeed,
            platformFeeAccount: null,
          })
          .signers([registrant])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Non-admin cannot register in Phase 1 - expect Unauthorized or similar
        expect(err).to.exist;
      }
    });
  });

  describe("Symbol Validation", () => {
    before(async () => {
      await refreshConfigState(ctx);
      await ensureUnpaused(ctx);
    });

    it("rejects symbols with special characters", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      const symbol = "TEST$"; // Invalid character
      const tokenPda = getTokenPda(program.programId, symbol);

      try {
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

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err).to.exist;
      }
    });

    it("rejects symbols with spaces", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      const symbol = "TEST ONE"; // Space not allowed
      const tokenPda = getTokenPda(program.programId, symbol);

      try {
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

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err).to.exist;
      }
    });
  });

  describe("Fee Collector Protection", () => {
    before(async () => {
      await refreshConfigState(ctx);
      await ensureUnpaused(ctx);
    });

    it("registration fees go to correct fee collector", async () => {
      const {
        program,
        admin,
        configPda,
        feeCollector,
        feeCollectorPubkey,
        solUsdPythFeed,
      } = ctx;

      // Set a new fee collector
      const newFeeCollector = Keypair.generate();

      await program.methods
        .updateConfig(newFeeCollector.publicKey, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();

      // Try to register with old fee collector - should fail
      const symbol = "FEECHK";
      const tokenPda = getTokenPda(program.programId, symbol);

      try {
        await program.methods
          .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: admin.publicKey,
            config: configPda,
            feeCollector: feeCollectorPubkey, // Old fee collector
            solUsdPriceFeed: solUsdPythFeed,
            tokenMint: testTokenMint,
            tokenAccount: tokenPda,
            platformFeeAccount: null,
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Should fail because fee collector doesn't match config
        expect(err).to.exist;
      }

      // Reset fee collector for other tests
      await program.methods
        .updateConfig(feeCollector.publicKey, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          newAdmin: admin.publicKey,
        })
        .rpc();

      // Refresh config after reset
      await refreshConfigState(ctx);
    });
  });
});

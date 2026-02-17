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

describe("TNS - Security Tests", () => {
  let ctx: TestContext;
  // Store mints for each symbol
  const tokenMints: Map<string, PublicKey> = new Map();

  // Helper to get or create a token mint with matching metadata
  async function getOrCreateTokenMint(symbol: string): Promise<PublicKey> {
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

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);
  });

  describe("Paused State", () => {
    let tokenForRenewal: anchor.web3.PublicKey;
    let pauseTestMint: anchor.web3.PublicKey;
    let pauseTestMetadata: anchor.web3.PublicKey;

    before(async () => {
      // Refresh config before each test block
      await refreshConfigState(ctx);

      // Ensure protocol is unpaused for setup
      await ensureUnpaused(ctx);

      // Register a symbol we can try to renew when paused (as admin for Phase 1)
      const symbol = "PAUSETEST";
      tokenForRenewal = getTokenPda(ctx.program.programId, symbol);
      pauseTestMint = await getOrCreateTokenMint(symbol);
      pauseTestMetadata = getMetadataPda(pauseTestMint);

      await ctx.program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: tokenForRenewal,
          tokenMint: pauseTestMint,
          tokenMetadata: pauseTestMetadata,
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
        .updateConfig(null, true, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      const symbol = "PAUSED1";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      try {
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

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Paused");
      }

      // Unpause for other tests
      await program.methods
        .updateConfig(null, false, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    });

    it("cannot renew symbols when paused", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Pause the protocol
      await program.methods
        .updateConfig(null, true, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
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
        .updateConfig(null, false, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    });

    it("cannot update mint when paused", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Pause the protocol
      await program.methods
        .updateConfig(null, true, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      // Create a new mint for update attempt
      const newMint = await getOrCreateTokenMint("PAUSETEST"); // Same symbol
      const newMintMetadata = getMetadataPda(newMint);

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
            newMint: newMint,
            newMintMetadata: newMintMetadata,
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Paused");
      }

      // Unpause for other tests
      await program.methods
        .updateConfig(null, false, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
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
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      // In Phase 1, admin should be able to register reserved symbols
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
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      try {
        await program.methods
          .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: registrant.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: tokenMetadata,
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

    it("allows symbols with special characters if metadata matches", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Special characters are now allowed - Metaplex matching is the gatekeeper
      const symbol = "TEST$";
      const tokenPda = getTokenPda(program.programId, symbol);
      // Create token with matching special character symbol
      const tokenMint = await getOrCreateTokenMint(symbol);
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

      const tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal(symbol);
    });

    it("rejects when symbol doesn't match metadata", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
        ctx;

      // Try to register with a symbol that doesn't match the metadata
      const symbol = "MISMATCH";
      const tokenPda = getTokenPda(program.programId, symbol);
      // Create token with DIFFERENT symbol
      const tokenMint = await getOrCreateTokenMint("DIFFERENT");
      const tokenMetadata = getMetadataPda(tokenMint);

      try {
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

        expect.fail("Should have thrown MetadataSymbolMismatch error");
      } catch (err) {
        expect(err.message).to.include("MetadataSymbolMismatch");
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
        .updateConfig(newFeeCollector.publicKey, null, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      // Try to register with old fee collector - should fail
      const symbol = "FEECHK";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      try {
        await program.methods
          .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: admin.publicKey,
            config: configPda,
            feeCollector: feeCollectorPubkey, // Old fee collector
            solUsdPriceFeed: solUsdPythFeed,
            tokenMint: tokenMint,
            tokenMetadata: tokenMetadata,
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
        .updateConfig(feeCollector.publicKey, null, null, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      // Refresh config after reset
      await refreshConfigState(ctx);
    });
  });

  describe("Phase 2: Non-admin Registration", () => {
    const symbol = "PHASE2";
    let tokenPda: PublicKey;
    let tokenMint: PublicKey;
    let tokenMetadata: PublicKey;
    let mintAuthority: Keypair;

    before(async () => {
      mintAuthority = Keypair.generate();
      await fundAccounts(ctx.provider, mintAuthority);

      // Create mint
      tokenMint = await createMint(
        ctx.provider.connection,
        mintAuthority,
        mintAuthority.publicKey,
        null,
        9
      );

      tokenMetadata = getMetadataPda(tokenMint);
      tokenPda = getTokenPda(ctx.program.programId, symbol);

      // Create metadata
      const createMetadataIx = createMetadataV3Ix(
        tokenMetadata,
        tokenMint,
        mintAuthority.publicKey,
        mintAuthority.publicKey,
        mintAuthority.publicKey,
        `${symbol} Token`,
        symbol,
        "",
        false
      );

      const tx = new anchor.web3.Transaction().add(createMetadataIx);
      await anchor.web3.sendAndConfirmTransaction(ctx.provider.connection, tx, [mintAuthority]);

      // Advance to Phase 2 if needed
      await refreshConfigState(ctx);
      if (ctx.currentPhase < 2) {
        await ctx.program.methods
          .updateConfig(null, null, 2, null, null)
          .accountsPartial({
            admin: ctx.admin.publicKey,
            config: ctx.configPda,
          })
          .rpc();
        ctx.currentPhase = 2;
      }
    });

    it("non-admin can register symbol in Phase 2", async () => {
      const { program, configPda, registrant } = ctx;

      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: registrant.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          solUsdPriceFeed: ctx.solUsdPythFeed,
          platformFeeAccount: null,
        })
        .signers([registrant])
        .rpc();

      const token = await program.account.token.fetch(tokenPda);
      expect(token.symbol).to.equal(symbol);
      expect(token.owner.toString()).to.equal(registrant.publicKey.toString());
    });
  });
});

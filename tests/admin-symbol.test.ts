import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  fundAccounts,
  getTokenPda,
  createTokenWithMetadata,
  getMetadataPda,
} from "./helpers/setup";

describe("TNS - Admin Symbol Operations", () => {
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
  });

  describe("seed_symbol", () => {
    it("admin can seed a symbol with 10 years", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "SEED10";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      await program.methods
        .seedSymbol(symbol, 10, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(tokenPda);

      expect(tokenAccount.symbol).to.equal(symbol);
      expect(tokenAccount.mint.toString()).to.equal(tokenMint.toString());
      // Owner should be the passed owner (admin in this case)
      expect(tokenAccount.owner.toString()).to.equal(admin.publicKey.toString());

      // Verify expiration is ~10 years from now
      const now = Math.floor(Date.now() / 1000);
      const tenYears = 10 * 31_557_600;
      expect(tokenAccount.expiresAt.toNumber()).to.be.closeTo(now + tenYears, 60);
    });

    it("admin can seed a symbol with default 2 years", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "SEED2";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      await program.methods
        .seedSymbol(symbol, 2, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(tokenPda);

      // Verify expiration is ~2 years from now
      const now = Math.floor(Date.now() / 1000);
      const twoYears = 2 * 31_557_600;
      expect(tokenAccount.expiresAt.toNumber()).to.be.closeTo(now + twoYears, 60);
    });

    it("admin can seed a symbol with 1 year", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "SEED1";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      await program.methods
        .seedSymbol(symbol, 1, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(tokenPda);

      // Verify expiration is ~1 year from now
      const now = Math.floor(Date.now() / 1000);
      const oneYear = 31_557_600;
      expect(tokenAccount.expiresAt.toNumber()).to.be.closeTo(now + oneYear, 60);
    });

    it("fails with invalid years (0)", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "SEEDFAIL0";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      try {
        await program.methods
          .seedSymbol(symbol, 0, admin.publicKey)
          .accountsPartial({
            admin: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: tokenMetadata,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("InvalidYears");
      }
    });

    it("fails with invalid years (>10)", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "SEEDFAIL11";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      try {
        await program.methods
          .seedSymbol(symbol, 11, admin.publicKey)
          .accountsPartial({
            admin: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: tokenMetadata,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("ExceedsMaxYears");
      }
    });

    it("non-admin cannot seed a symbol", async () => {
      const { program, configPda, registrant } = ctx;
      const symbol = "SEEDUNAUTH";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      try {
        await program.methods
          .seedSymbol(symbol, 10, registrant.publicKey)
          .accountsPartial({
            admin: registrant.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: tokenMetadata,
            systemProgram: SystemProgram.programId,
          })
          .signers([registrant])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Unauthorized");
      }
    });
  });

  describe("admin_update_symbol", () => {
    const updateSymbol = "UPTEST";
    let updateTokenPda: PublicKey;
    let updateTokenMint: PublicKey;
    let updateTokenMint2: PublicKey;

    before(async () => {
      // Seed a symbol for update tests
      const { program, admin, configPda } = ctx;
      updateTokenPda = getTokenPda(program.programId, updateSymbol);
      updateTokenMint = await getOrCreateTokenMint(updateSymbol);
      const tokenMetadata = getMetadataPda(updateTokenMint);
      // Create a second mint for update tests (same symbol, different mint for admin override)
      updateTokenMint2 = await getOrCreateTokenMint(updateSymbol + "2");

      await program.methods
        .seedSymbol(updateSymbol, 5, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: updateTokenPda,
          tokenMint: updateTokenMint,
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("admin can update owner", async () => {
      const { program, admin, configPda } = ctx;
      const newOwner = Keypair.generate();

      await program.methods
        .adminUpdateSymbol(newOwner.publicKey, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: updateTokenPda,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(updateTokenPda);
      expect(tokenAccount.owner.toString()).to.equal(newOwner.publicKey.toString());

      // Restore original owner for subsequent tests
      await program.methods
        .adminUpdateSymbol(admin.publicKey, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: updateTokenPda,
        })
        .rpc();
    });

    it("admin can update mint", async () => {
      const { program, admin, configPda } = ctx;

      const tokenBefore = await program.account.token.fetch(updateTokenPda);
      expect(tokenBefore.mint.toString()).to.equal(updateTokenMint.toString());

      await program.methods
        .adminUpdateSymbol(null, updateTokenMint2, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: updateTokenPda,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(updateTokenPda);
      expect(tokenAccount.mint.toString()).to.equal(updateTokenMint2.toString());

      // Restore original mint
      await program.methods
        .adminUpdateSymbol(null, updateTokenMint, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: updateTokenPda,
        })
        .rpc();
    });

    it("admin can update expiration", async () => {
      const { program, admin, configPda } = ctx;

      const newExpiration = Math.floor(Date.now() / 1000) + (20 * 31_557_600); // 20 years from now

      await program.methods
        .adminUpdateSymbol(null, null, new BN(newExpiration))
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: updateTokenPda,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(updateTokenPda);
      expect(tokenAccount.expiresAt.toNumber()).to.equal(newExpiration);
    });

    it("admin can update multiple fields at once", async () => {
      const { program, admin, configPda } = ctx;
      const newOwner = Keypair.generate();
      const newExpiration = Math.floor(Date.now() / 1000) + (15 * 31_557_600);

      await program.methods
        .adminUpdateSymbol(newOwner.publicKey, updateTokenMint2, new BN(newExpiration))
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: updateTokenPda,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(updateTokenPda);
      expect(tokenAccount.owner.toString()).to.equal(newOwner.publicKey.toString());
      expect(tokenAccount.mint.toString()).to.equal(updateTokenMint2.toString());
      expect(tokenAccount.expiresAt.toNumber()).to.equal(newExpiration);
    });

    it("non-admin cannot update symbol", async () => {
      const { program, configPda, registrant } = ctx;
      const newOwner = Keypair.generate();

      try {
        await program.methods
          .adminUpdateSymbol(newOwner.publicKey, null, null)
          .accountsPartial({
            admin: registrant.publicKey,
            config: configPda,
            tokenAccount: updateTokenPda,
          })
          .signers([registrant])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Unauthorized");
      }
    });
  });

  describe("admin_close_symbol", () => {
    it("admin can close a symbol", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "CLOSETEST";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      // First seed the symbol
      await program.methods
        .seedSymbol(symbol, 5, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Verify it exists
      let tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal(symbol);

      // Now close it
      await program.methods
        .adminCloseSymbol()
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
        })
        .rpc();

      // Verify it's closed (should throw when trying to fetch)
      try {
        await program.account.token.fetch(tokenPda);
        expect.fail("Account should be closed");
      } catch (err) {
        expect(err.message).to.include("Account does not exist");
      }
    });

    it("symbol can be re-registered after admin close", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "REOPEN";
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);
      // Create a different mint for re-registration
      const tokenMint2 = await getOrCreateTokenMint(symbol + "V2");
      const tokenMetadata2 = getMetadataPda(tokenMint2);

      // Seed the symbol
      await program.methods
        .seedSymbol(symbol, 3, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Close it
      await program.methods
        .adminCloseSymbol()
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
        })
        .rpc();

      // Re-seed it with different parameters (admin can use any mint via admin override)
      // Note: admin_update_symbol doesn't require metadata validation
      // But seed_symbol does, so we use the same symbol's mint
      await program.methods
        .seedSymbol(symbol, 7, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint, // Use same mint since it has matching symbol
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Verify the new registration
      const tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal(symbol);
      expect(tokenAccount.mint.toString()).to.equal(tokenMint.toString());

      // Verify expiration is ~7 years from now
      const now = Math.floor(Date.now() / 1000);
      const sevenYears = 7 * 31_557_600;
      expect(tokenAccount.expiresAt.toNumber()).to.be.closeTo(now + sevenYears, 60);
    });

    it("non-admin cannot close a symbol", async () => {
      const { program, admin, configPda, registrant } = ctx;
      const symbol = "NOCL" + Math.random().toString(36).substring(2, 5).toUpperCase();
      const tokenPda = getTokenPda(program.programId, symbol);
      const tokenMint = await getOrCreateTokenMint(symbol);
      const tokenMetadata = getMetadataPda(tokenMint);

      // Seed the symbol
      await program.methods
        .seedSymbol(symbol, 5, admin.publicKey)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Try to close as non-admin
      try {
        await program.methods
          .adminCloseSymbol()
          .accountsPartial({
            admin: registrant.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
          })
          .signers([registrant])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("Unauthorized");
      }

      // Cleanup - close the symbol
      await program.methods
        .adminCloseSymbol()
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
        })
        .rpc();
    });
  });
});

import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import {
  setupTest,
  ensureConfigInitialized,
  fundAccounts,
  TestContext,
} from "./helpers/setup";

describe("TNS - Update Config", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.feeCollector);
  });

  it("admin can transfer admin rights", async () => {
    const { program, admin, configPda } = ctx;

    const newAdmin = Keypair.generate();
    await fundAccounts(ctx.provider, newAdmin);

    // Transfer to new admin (new_admin must sign to prove consent)
    await program.methods
      .updateConfig(null, null, null, null, null)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        newAdmin: newAdmin.publicKey,
      })
      .signers([newAdmin])
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.admin.toString()).to.equal(newAdmin.publicKey.toString());

    // Transfer back to original admin
    await program.methods
      .updateConfig(null, null, null, null, null)
      .accountsPartial({
        admin: newAdmin.publicKey,
        config: configPda,
        newAdmin: admin.publicKey,
      })
      .signers([newAdmin])
      .rpc();

    const configAfter = await program.account.config.fetch(configPda);
    expect(configAfter.admin.toString()).to.equal(admin.publicKey.toString());
  });

  it("admin can update fee collector", async () => {
    const { program, admin, configPda } = ctx;

    const newFeeCollector = Keypair.generate();

    await program.methods
      .updateConfig(newFeeCollector.publicKey, null, null, null, null)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.feeCollector.toString()).to.equal(
      newFeeCollector.publicKey.toString()
    );

    // Update ctx for subsequent tests
    ctx.feeCollectorPubkey = newFeeCollector.publicKey;
  });

  it("admin can pause registrations", async () => {
    const { program, admin, configPda } = ctx;

    await program.methods
      .updateConfig(null, true, null, null, null)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.paused).to.equal(true);

    // Unpause
    await program.methods
      .updateConfig(null, false, null, null, null)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    const configAfter = await program.account.config.fetch(configPda);
    expect(configAfter.paused).to.equal(false);
  });

  it("non-admin cannot update config", async () => {
    const { program, configPda, registrant } = ctx;

    try {
      await program.methods
        .updateConfig(null, true, null, null, null)
        .accountsPartial({
          admin: registrant.publicKey,
          config: configPda,
        })
        .signers([registrant])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("Unauthorized");
    }
  });

  it("admin can set TNS oracle", async () => {
    const { program, admin, configPda } = ctx;

    const tnsOracle = Keypair.generate();

    await program.methods
      .updateConfig(null, null, null, tnsOracle.publicKey, null)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.tnsUsdPythFeed.toString()).to.equal(
      tnsOracle.publicKey.toString()
    );
  });

  // Phase transition tests
  describe("Phase Transitions", () => {
    it("admin can advance phase from 1 to 2", async () => {
      const { program, admin, configPda } = ctx;

      // Get current phase
      const configBefore = await program.account.config.fetch(configPda);

      // Skip if not at phase 1
      if (configBefore.phase !== 1) {
        console.log("Skipping: not at phase 1");
        return;
      }

      await program.methods
        .updateConfig(null, null, 2, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);
      expect(config.phase).to.equal(2);
    });

    it("admin can advance phase from 2 to 3", async () => {
      const { program, admin, configPda } = ctx;

      const configBefore = await program.account.config.fetch(configPda);

      // Skip if not at phase 2
      if (configBefore.phase !== 2) {
        console.log("Skipping: not at phase 2");
        return;
      }

      await program.methods
        .updateConfig(null, null, 3, null, null)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);
      expect(config.phase).to.equal(3);
    });

    it("fails to go backward in phase", async () => {
      const { program, admin, configPda } = ctx;

      const configBefore = await program.account.config.fetch(configPda);

      // Can only test if we're past phase 1
      if (configBefore.phase <= 1) {
        console.log("Skipping: still at phase 1");
        return;
      }

      try {
        await program.methods
          .updateConfig(null, null, 1, null, null) // Try to go back to phase 1
          .accountsPartial({
            admin: admin.publicKey,
            config: configPda,
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("InvalidPhase");
      }
    });

    it("fails to set phase beyond 3", async () => {
      const { program, admin, configPda } = ctx;

      try {
        await program.methods
          .updateConfig(null, null, 4, null, null)
          .accountsPartial({
            admin: admin.publicKey,
            config: configPda,
          })
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("InvalidPhase");
      }
    });
  });
});

use anchor_lang::prelude::*;

pub mod constants;
pub mod state;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod symbol_status;

pub use constants::*;
pub use state::*;
pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use symbol_status::*;

declare_id!("TNSxsGQYDPb7ddAtDEJAUhD3q4M232NdhmTXutVXQ12");

#[program]
pub mod tns {
    use super::*;

    /// Initialize the TNS protocol
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::admin::initialize::handler(ctx)
    }

    /// Update protocol configuration (admin only)
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_fee_collector: Option<Pubkey>,
        paused: Option<bool>,
        new_phase: Option<u8>,
        tns_usd_pyth_feed: Option<Pubkey>,
        keeper_reward_lamports: Option<u64>,
    ) -> Result<()> {
        instructions::admin::update_config::handler(
            ctx,
            new_fee_collector,
            paused,
            new_phase,
            tns_usd_pyth_feed,
            keeper_reward_lamports,
        )
    }

    /// Seed the registry with a verified token (admin only, no fee)
    /// Owner is passed explicitly - off-chain script should pass update_authority
    /// for legitimate tokens, or admin for tokens with burned authority.
    pub fn seed_symbol(ctx: Context<SeedSymbol>, symbol: String, years: u8, owner: Pubkey) -> Result<()> {
        instructions::admin::seed_symbol::handler(ctx, symbol, years, owner)
    }

    /// Force-update a symbol's owner, mint, or expiration (admin only)
    /// Use for fixing mistakes, revoking from bad actors, or extending for partners
    pub fn admin_update_symbol(
        ctx: Context<AdminUpdateSymbol>,
        new_owner: Option<Pubkey>,
        new_mint: Option<Pubkey>,
        new_expires_at: Option<i64>,
    ) -> Result<()> {
        instructions::admin::admin_update_symbol::handler(ctx, new_owner, new_mint, new_expires_at)
    }

    /// Force-close a symbol account (admin only)
    /// Closes the account immediately, returning rent to admin.
    /// The symbol becomes available for fresh registration.
    pub fn admin_close_symbol(ctx: Context<AdminCloseSymbol>) -> Result<()> {
        instructions::admin::admin_close_symbol::handler(ctx)
    }

    /// Register a new symbol paying with SOL
    pub fn register_symbol_sol(
        ctx: Context<RegisterSymbolSol>,
        symbol: String,
        years: u8,
        max_sol_cost: u64,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::register::sol::handler(ctx, symbol, years, max_sol_cost, platform_fee_bps)
    }

    /// Register a new symbol paying with TNS token (25% discount)
    pub fn register_symbol_tns(
        ctx: Context<RegisterSymbolTns>,
        symbol: String,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::register::tns::handler(ctx, symbol, years, platform_fee_bps)
    }

    /// Register a new symbol paying with USDC
    pub fn register_symbol_usdc(
        ctx: Context<RegisterSymbolUsdc>,
        symbol: String,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::register::usdc::handler(ctx, symbol, years, platform_fee_bps)
    }

    /// Register a new symbol paying with USDT
    pub fn register_symbol_usdt(
        ctx: Context<RegisterSymbolUsdt>,
        symbol: String,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::register::usdt::handler(ctx, symbol, years, platform_fee_bps)
    }

    /// Renew a symbol paying with SOL
    pub fn renew_symbol_sol(
        ctx: Context<RenewSymbolSol>,
        years: u8,
        max_sol_cost: u64,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::renew::sol::handler(ctx, years, max_sol_cost, platform_fee_bps)
    }

    /// Renew a symbol paying with TNS token (25% discount)
    pub fn renew_symbol_tns(
        ctx: Context<RenewSymbolTns>,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::renew::tns::handler(ctx, years, platform_fee_bps)
    }

    /// Renew a symbol paying with USDC
    pub fn renew_symbol_usdc(
        ctx: Context<RenewSymbolUsdc>,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::renew::usdc::handler(ctx, years, platform_fee_bps)
    }

    /// Renew a symbol paying with USDT
    pub fn renew_symbol_usdt(
        ctx: Context<RenewSymbolUsdt>,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::renew::usdt::handler(ctx, years, platform_fee_bps)
    }

    /// Claim an expired symbol paying with SOL (anyone can claim expired symbols)
    pub fn claim_expired_symbol_sol(
        ctx: Context<ClaimExpiredSymbolSol>,
        years: u8,
        max_sol_cost: u64,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::claim::sol::handler(ctx, years, max_sol_cost, platform_fee_bps)
    }

    /// Claim an expired symbol paying with TNS token (25% discount)
    pub fn claim_expired_symbol_tns(
        ctx: Context<ClaimExpiredSymbolTns>,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::claim::tns::handler(ctx, years, platform_fee_bps)
    }

    /// Claim an expired symbol paying with USDC
    pub fn claim_expired_symbol_usdc(
        ctx: Context<ClaimExpiredSymbolUsdc>,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::claim::usdc::handler(ctx, years, platform_fee_bps)
    }

    /// Claim an expired symbol paying with USDT
    pub fn claim_expired_symbol_usdt(
        ctx: Context<ClaimExpiredSymbolUsdt>,
        years: u8,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::claim::usdt::handler(ctx, years, platform_fee_bps)
    }

    /// Update the mint associated with a symbol paying with SOL (owner only)
    pub fn update_mint_sol(
        ctx: Context<UpdateMintSol>,
        max_sol_cost: u64,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::update_mint::sol::handler(ctx, max_sol_cost, platform_fee_bps)
    }

    /// Update the mint associated with a symbol paying with TNS (25% discount)
    pub fn update_mint_tns(
        ctx: Context<UpdateMintTns>,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::update_mint::tns::handler(ctx, platform_fee_bps)
    }

    /// Update the mint associated with a symbol paying with USDC
    pub fn update_mint_usdc(
        ctx: Context<UpdateMintUsdc>,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::update_mint::usdc::handler(ctx, platform_fee_bps)
    }

    /// Update the mint associated with a symbol paying with USDT
    pub fn update_mint_usdt(
        ctx: Context<UpdateMintUsdt>,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::registrar::update_mint::usdt::handler(ctx, platform_fee_bps)
    }

    /// Transfer ownership of a symbol to a new owner
    pub fn transfer_ownership(
        ctx: Context<TransferOwnership>,
        new_owner: Pubkey,
    ) -> Result<()> {
        instructions::registrar::transfer_ownership::handler(ctx, new_owner)
    }

    /// Claim ownership of a symbol by proving token authority
    ///
    /// Allows the rightful owner of a token to claim the TNS record even if
    /// someone else registered it first. Three paths to claim:
    /// 1. Mint authority - if you control the mint, you control the token
    /// 2. Metadata update authority - if you control metadata, you control the brand
    /// 3. Majority holder (>50%) - if you hold majority supply, you have economic control
    ///
    /// This creates a clear ownership hierarchy where token authority always
    /// takes precedence over TNS ownership.
    pub fn claim_ownership(ctx: Context<ClaimOwnership>) -> Result<()> {
        instructions::registrar::claim_ownership::handler(ctx)
    }

    /// Cancel an abandoned symbol (1+ year past grace period)
    /// Closes the account, keeper receives rent + keeper reward
    pub fn cancel_symbol(ctx: Context<CancelSymbol>) -> Result<()> {
        instructions::registrar::cancel_symbol::handler(ctx)
    }

    /// Verify that a registered symbol still matches its mint's metadata.
    /// If the metadata symbol has drifted (owner changed it), the account
    /// is closed and keeper receives the rent as reward.
    /// Economic enforcement: change metadata = lose registration + rent
    pub fn verify_or_close(ctx: Context<VerifyOrClose>) -> Result<()> {
        instructions::registrar::verify_or_close::handler(ctx)
    }
}

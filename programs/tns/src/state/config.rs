use anchor_lang::prelude::*;
use crate::{MAX_REGISTRATION_YEARS, MULTI_YEAR_DISCOUNT_BPS, SECONDS_PER_YEAR};

/// Global config for the TNS protocol
/// PDA seeds: ["config"]
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin authority who can update config (before immutability)
    pub admin: Pubkey,

    /// Fee collector - where 100% of token registration fees go
    pub fee_collector: Pubkey,

    /// Base price per year in USD micro-cents (10_000_000 = $10.00)
    pub base_price_usd_micro: u64,

    /// Annual price increase in basis points (700 = 7%)
    pub annual_increase_bps: u16,

    /// Fee for updating mint in basis points of current price
    pub update_fee_bps: u16,

    /// Pyth price account for SOL/USD (push oracle)
    pub sol_usd_pyth_feed: Pubkey,

    /// Optional Pyth price account for TNS/USD
    /// When None, TNS is pegged at $1. When set, uses market price.
    pub tns_usd_pyth_feed: Option<Pubkey>,

    /// Fixed keeper reward in lamports (paid separately from registration fee)
    pub keeper_reward_lamports: u64,

    /// Protocol launch timestamp (for calculating price increases)
    pub launch_timestamp: i64,

    /// Whether new registrations are paused
    pub paused: bool,

    /// Current protocol phase (1 = Genesis, 2 = Open Registration, 3 = Full Decentralization)
    /// Phase 1: Only whitelisted mint authorities or admin can register
    /// Phase 2: Anyone can register non-whitelisted symbols, whitelist still protected
    /// Phase 3: Whitelist removed, anyone can register any symbol
    pub phase: u8,

    /// PDA bump seed
    pub bump: u8,

    /// Reserved for future use
    pub _reserved: [u8; 128],
}

impl Config {
    pub const SEED_PREFIX: &'static [u8] = b"config";

    /// Calculate the current yearly price in USD micro-cents based on time since launch
    /// Price increases 7% annually (global, not per-symbol)
    pub fn get_current_yearly_price_usd(&self, current_time: i64) -> u64 {
        let years_since_launch = (current_time - self.launch_timestamp) / SECONDS_PER_YEAR;
        if years_since_launch <= 0 {
            return self.base_price_usd_micro;
        }

        // Compound 7% increase: price * (1.07)^years
        // Using fixed-point math: multiply by 10700, divide by 10000 each year
        let mut price = self.base_price_usd_micro as u128;
        for _ in 0..years_since_launch.min(50) {
            // Cap at 50 years to prevent overflow
            price = price * (10000 + self.annual_increase_bps as u128) / 10000;
        }
        price as u64
    }

    /// Calculate total price in USD micro-cents for multi-year registration with discount
    pub fn calculate_registration_price_usd(&self, current_time: i64, years: u8) -> u64 {
        let years = years.min(MAX_REGISTRATION_YEARS) as usize;
        if years == 0 {
            return 0;
        }

        let yearly_price = self.get_current_yearly_price_usd(current_time);
        let base_total = yearly_price * years as u64;

        // Apply multi-year discount
        let discount_bps = MULTI_YEAR_DISCOUNT_BPS[years - 1];
        let discount = base_total * discount_bps as u64 / 10000;

        base_total - discount
    }

    /// Convert USD micro-cents to lamports using SOL/USD price
    /// sol_price_micro is the SOL/USD price in micro-cents (e.g., 200_000_000 = $200.00)
    pub fn usd_to_lamports(&self, usd_micro: u64, sol_price_micro: u64) -> u64 {
        // usd_micro / sol_price_micro * LAMPORTS_PER_SOL
        // = usd_micro * LAMPORTS_PER_SOL / sol_price_micro
        // Using u128 to prevent overflow
        let lamports = (usd_micro as u128) * 1_000_000_000u128 / (sol_price_micro as u128);
        lamports as u64
    }

    /// Calculate total price in lamports for registration
    /// sol_price_micro is the SOL/USD price in micro-cents from Pyth
    pub fn calculate_registration_price_lamports(
        &self,
        current_time: i64,
        years: u8,
        sol_price_micro: u64,
    ) -> u64 {
        let usd_price = self.calculate_registration_price_usd(current_time, years);
        self.usd_to_lamports(usd_price, sol_price_micro)
    }

    /// Get fixed keeper reward in lamports
    pub fn get_keeper_reward_lamports(&self) -> u64 {
        self.keeper_reward_lamports
    }

    /// Check if TNS oracle pricing is enabled
    pub fn has_tns_oracle(&self) -> bool {
        self.tns_usd_pyth_feed.is_some()
    }
}

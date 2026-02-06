use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, transfer_checked, TransferChecked};
use crate::{
    Config, TnsError, MAX_PRICE_STALENESS_SECONDS, PYTH_MAGIC, PYTH_PROGRAM_ID,
    PUMP_POOL_TNS_RESERVE, PUMP_POOL_SOL_RESERVE, SOL_DECIMALS, STABLECOIN_DECIMALS,
};

// ============================================================================
// SOL Fee Calculations
// ============================================================================

/// Fee breakdown for SOL payments (requires price conversion)
pub struct SolFeeBreakdown {
    /// Fee in lamports
    pub fee_lamports: u64,
    /// Fixed keeper reward in lamports
    pub keeper_reward_lamports: u64,
}

/// Calculate registration/renewal fees for SOL payments
pub fn calculate_fees_sol(
    config: &Config,
    current_time: i64,
    years: u8,
    sol_price_feed: &AccountInfo,
) -> Result<SolFeeBreakdown> {
    let sol_price_micro = get_sol_price_micro(sol_price_feed, current_time)?;

    let fee_lamports = config.calculate_registration_price_lamports(current_time, years, sol_price_micro);
    let keeper_reward_lamports = config.get_keeper_reward_lamports();

    Ok(SolFeeBreakdown {
        fee_lamports,
        keeper_reward_lamports,
    })
}

/// Transfer SOL fees for registration (includes keeper reward to config PDA)
/// 100% of fee goes to fee collector, fixed keeper reward goes to Config PDA
pub fn transfer_sol_registration_fees<'info>(
    payer: &AccountInfo<'info>,
    fee_collector: &AccountInfo<'info>,
    config: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    fees: &SolFeeBreakdown,
) -> Result<u64> {
    // Transfer 100% to fee collector
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.clone(),
            anchor_lang::system_program::Transfer {
                from: payer.clone(),
                to: fee_collector.clone(),
            },
        ),
        fees.fee_lamports,
    )?;

    // Transfer fixed keeper reward to Config PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.clone(),
            anchor_lang::system_program::Transfer {
                from: payer.clone(),
                to: config.clone(),
            },
        ),
        fees.keeper_reward_lamports,
    )?;

    Ok(fees.keeper_reward_lamports)
}

/// Transfer SOL fees for renewal or claim (no keeper reward)
/// 100% of fee goes to fee collector
pub fn transfer_sol_renewal_fees<'info>(
    payer: &AccountInfo<'info>,
    fee_collector: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    fee_lamports: u64,
) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.clone(),
            anchor_lang::system_program::Transfer {
                from: payer.clone(),
                to: fee_collector.clone(),
            },
        ),
        fee_lamports,
    )?;

    Ok(())
}

// ============================================================================
// Update Fee Calculations
// ============================================================================

/// Result of update fee calculation
pub struct UpdateFeeBreakdown {
    pub fee_lamports: u64,
    pub fee_usd_micro: u64,
}

/// Calculate update mint fee
pub fn calculate_update_fee(
    config: &Config,
    current_time: i64,
    sol_price_feed: &AccountInfo,
) -> Result<UpdateFeeBreakdown> {
    let sol_price_micro = get_sol_price_micro(sol_price_feed, current_time)?;

    let yearly_price_usd_micro = config.get_current_yearly_price_usd(current_time);
    let fee_usd_micro = yearly_price_usd_micro * config.update_fee_bps as u64 / 10000;
    let fee_lamports = config.usd_to_lamports(fee_usd_micro, sol_price_micro);

    Ok(UpdateFeeBreakdown {
        fee_lamports,
        fee_usd_micro,
    })
}

/// Transfer SOL fee for update_mint (no keeper reward for updates)
pub fn transfer_sol_update_fee<'info>(
    owner: &AccountInfo<'info>,
    fee_collector: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    fee: &UpdateFeeBreakdown,
) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.clone(),
            anchor_lang::system_program::Transfer {
                from: owner.clone(),
                to: fee_collector.clone(),
            },
        ),
        fee.fee_lamports,
    )?;
    Ok(())
}

// ============================================================================
// Stablecoin Fee Transfers
// ============================================================================

/// Accounts needed for token-based fee transfers (TNS, USDC, USDT)
pub struct TokenFeeTransferAccounts<'a, 'info> {
    pub payer: &'a Signer<'info>,
    pub payer_token_account: &'a InterfaceAccount<'info, TokenAccount>,
    pub vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub token_program: &'a Interface<'info, TokenInterface>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Fee breakdown for token payments (TNS, USDC, USDT)
pub struct TokenFeeBreakdown {
    /// Fee in USD micro-cents
    pub fee_usd_micro: u64,
    /// Fixed keeper reward in lamports
    pub keeper_reward_lamports: u64,
}

/// Transfer stablecoin (USDC/USDT) fees for registration (no discount, includes keeper reward)
/// 100% of fee goes to treasury, fixed keeper reward in SOL to Config PDA
pub fn transfer_stablecoin_registration_fees<'info>(
    accounts: &TokenFeeTransferAccounts<'_, 'info>,
    fees: &TokenFeeBreakdown,
    config: &AccountInfo<'info>,
) -> Result<u64> {
    // Transfer 100% to vault (treasury)
    // Note: fee_usd_micro equals token amount for 6-decimal stablecoins at $1 peg
    transfer_checked(
        CpiContext::new(
            accounts.token_program.to_account_info(),
            TransferChecked {
                from: accounts.payer_token_account.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.vault.to_account_info(),
                authority: accounts.payer.to_account_info(),
            },
        ),
        fees.fee_usd_micro,
        accounts.mint.decimals,
    )?;

    // Fixed keeper reward in SOL to Config PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            accounts.system_program.clone(),
            anchor_lang::system_program::Transfer {
                from: accounts.payer.to_account_info(),
                to: config.clone(),
            },
        ),
        fees.keeper_reward_lamports,
    )?;

    Ok(fees.keeper_reward_lamports)
}

/// Transfer stablecoin (USDC/USDT) fees for renewal or claim (no discount, no keeper reward)
/// 100% of fee goes to treasury
pub fn transfer_stablecoin_renewal_fees<'info>(
    accounts: &TokenFeeTransferAccounts<'_, 'info>,
    fee_usd_micro: u64,
) -> Result<()> {
    // Transfer 100% to vault (treasury)
    // Note: fee_usd_micro equals token amount for 6-decimal stablecoins at $1 peg
    transfer_checked(
        CpiContext::new(
            accounts.token_program.to_account_info(),
            TransferChecked {
                from: accounts.payer_token_account.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.vault.to_account_info(),
                authority: accounts.payer.to_account_info(),
            },
        ),
        fee_usd_micro,
        accounts.mint.decimals,
    )?;

    Ok(())
}

/// Transfer stablecoin fee for update_mint (no discount)
pub fn transfer_stablecoin_update_fee<'info>(
    owner: &Signer<'info>,
    owner_token_account: &InterfaceAccount<'info, TokenAccount>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    fee: &UpdateFeeBreakdown,
) -> Result<()> {
    // Note: fee_usd_micro equals token amount for 6-decimal stablecoins at $1 peg
    transfer_checked(
        CpiContext::new(
            token_program.to_account_info(),
            TransferChecked {
                from: owner_token_account.to_account_info(),
                mint: mint.to_account_info(),
                to: vault.to_account_info(),
                authority: owner.to_account_info(),
            },
        ),
        fee.fee_usd_micro,
        mint.decimals,
    )?;
    Ok(())
}

// ============================================================================
// Platform Fee Support
// ============================================================================

/// Calculate platform fee from total fee
/// Returns (treasury_amount, platform_amount)
pub fn calculate_platform_split(total_amount: u64, platform_fee_bps: u16) -> (u64, u64) {
    if platform_fee_bps == 0 {
        return (total_amount, 0);
    }
    let platform_amount = total_amount * platform_fee_bps as u64 / 10000;
    let treasury_amount = total_amount - platform_amount;
    (treasury_amount, platform_amount)
}

/// Transfer SOL fees with optional platform fee split
/// Used for registration, renewal, claim operations
pub fn transfer_sol_fees_with_platform<'info>(
    payer: &AccountInfo<'info>,
    fee_collector: &AccountInfo<'info>,
    platform_fee_account: Option<&AccountInfo<'info>>,
    system_program: &AccountInfo<'info>,
    fee_lamports: u64,
    platform_fee_bps: u16,
) -> Result<u64> {
    let (treasury_amount, platform_amount) = calculate_platform_split(fee_lamports, platform_fee_bps);

    // Transfer to treasury (fee collector)
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.clone(),
            anchor_lang::system_program::Transfer {
                from: payer.clone(),
                to: fee_collector.clone(),
            },
        ),
        treasury_amount,
    )?;

    // Transfer platform fee if applicable
    if platform_amount > 0 {
        if let Some(platform) = platform_fee_account {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    system_program.clone(),
                    anchor_lang::system_program::Transfer {
                        from: payer.clone(),
                        to: platform.clone(),
                    },
                ),
                platform_amount,
            )?;
        }
    }

    Ok(platform_amount)
}

/// Accounts needed for token fee transfers with platform fee split
pub struct PlatformTokenFeeAccounts<'a, 'info> {
    pub payer: &'a Signer<'info>,
    pub payer_token_account: &'a InterfaceAccount<'info, TokenAccount>,
    pub vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub platform_token_account: Option<&'a AccountInfo<'info>>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub token_program: &'a Interface<'info, TokenInterface>,
}

/// Transfer token fees with optional platform fee split
/// Used for USDC, USDT, TNS operations
/// Note: platform_token_account is unchecked - if platform provides wrong account, they lose their fees
pub fn transfer_token_fees_with_platform<'info>(
    accounts: &PlatformTokenFeeAccounts<'_, 'info>,
    token_amount: u64,
    platform_fee_bps: u16,
) -> Result<u64> {
    let (treasury_amount, platform_amount) = calculate_platform_split(token_amount, platform_fee_bps);

    // Transfer to treasury vault
    transfer_checked(
        CpiContext::new(
            accounts.token_program.to_account_info(),
            TransferChecked {
                from: accounts.payer_token_account.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.vault.to_account_info(),
                authority: accounts.payer.to_account_info(),
            },
        ),
        treasury_amount,
        accounts.mint.decimals,
    )?;

    // Transfer platform fee if applicable
    if platform_amount > 0 {
        if let Some(platform) = accounts.platform_token_account {
            transfer_checked(
                CpiContext::new(
                    accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: accounts.payer_token_account.to_account_info(),
                        mint: accounts.mint.to_account_info(),
                        to: platform.clone(),
                        authority: accounts.payer.to_account_info(),
                    },
                ),
                platform_amount,
                accounts.mint.decimals,
            )?;
        }
    }

    Ok(platform_amount)
}

// ============================================================================
// Price Oracle Functions
// ============================================================================

/// Get SOL/USD price from Pyth feed in micro-cents (1 USD = 1_000_000 micro-cents)
/// Parses Pyth price account format directly to avoid SDK version conflicts
pub fn get_sol_price_micro(price_feed_account: &AccountInfo, current_timestamp: i64) -> Result<u64> {
    let data = price_feed_account.try_borrow_data()?;

    // Verify the account is owned by the Pyth program
    require!(
        price_feed_account.owner == &PYTH_PROGRAM_ID,
        TnsError::InvalidPriceFeed
    );

    // Verify Pyth magic number (first 4 bytes)
    require!(data.len() >= 48, TnsError::InvalidPriceFeed);
    let magic = u32::from_le_bytes(data[0..4].try_into().unwrap());
    require!(magic == PYTH_MAGIC, TnsError::InvalidPriceFeed);

    // Pyth price account layout (v2):
    // Offset 32: exponent (i32)
    // Offset 208: aggregate price (i64)
    // Offset 224: aggregate publish time (i64)
    require!(data.len() >= 232, TnsError::InvalidPriceFeed);

    let exponent = i32::from_le_bytes(data[32..36].try_into().unwrap());
    let price = i64::from_le_bytes(data[208..216].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[224..232].try_into().unwrap());

    // Check staleness
    require!(
        current_timestamp - publish_time <= MAX_PRICE_STALENESS_SECONDS,
        TnsError::StalePriceFeed
    );

    // Ensure price is positive
    require!(price > 0, TnsError::InvalidPriceFeed);

    // Convert to micro-cents (6 decimal places)
    // Pyth SOL/USD typically has exponent -8, so price of $200 = 20000000000 * 10^-8
    // We want 200_000_000 micro-cents
    let price_value = price as i128;
    let target_exp = exponent + 6;
    let sol_price_micro = if target_exp >= 0 {
        (price_value * 10i128.pow(target_exp as u32)) as u64
    } else {
        (price_value / 10i128.pow((-target_exp) as u32)) as u64
    };

    Ok(sol_price_micro)
}

/// Get TNS/USD price from DEX pool reserves combined with Pyth SOL/USD price
/// Returns price in micro-cents (1 USD = 1_000_000 micro-cents)
///
/// Formula:
///   tns_price_sol = sol_reserve / tns_reserve (adjusted for decimals)
///   tns_price_usd = tns_price_sol * sol_price_usd
pub fn get_tns_price_from_pool(
    pool_tns_reserve: &AccountInfo,
    pool_sol_reserve: &AccountInfo,
    sol_usd_price_feed: &AccountInfo,
    current_timestamp: i64,
) -> Result<u64> {
    // Verify accounts match expected constants
    require!(
        pool_tns_reserve.key() == PUMP_POOL_TNS_RESERVE,
        TnsError::InvalidPoolReserve
    );
    require!(
        pool_sol_reserve.key() == PUMP_POOL_SOL_RESERVE,
        TnsError::InvalidPoolReserve
    );

    // Read token account balances (SPL Token account layout: amount is at offset 64, 8 bytes)
    let tns_data = pool_tns_reserve.try_borrow_data()?;
    let sol_data = pool_sol_reserve.try_borrow_data()?;

    require!(tns_data.len() >= 72, TnsError::InvalidPoolReserve);
    require!(sol_data.len() >= 72, TnsError::InvalidPoolReserve);

    let tns_reserve = u64::from_le_bytes(tns_data[64..72].try_into().unwrap());
    let sol_reserve = u64::from_le_bytes(sol_data[64..72].try_into().unwrap());

    // Ensure non-zero reserves
    require!(tns_reserve > 0 && sol_reserve > 0, TnsError::EmptyPoolReserves);

    // Get SOL/USD price from Pyth (returns micro USD, 6 decimals)
    let sol_price_usd = get_sol_price_micro(sol_usd_price_feed, current_timestamp)?;

    // Calculate TNS price in USD micro
    // tns_price_usd = (sol_reserve / tns_reserve) * sol_price_usd
    //
    // Decimal adjustment:
    // - sol_reserve: 9 decimals (SOL)
    // - tns_reserve: 6 decimals (TNS)
    // - sol_price_usd: 6 decimals (micro USD)
    // - Result should be: 6 decimals (micro USD)
    //
    // Formula: (sol_reserve * sol_price_usd) / (tns_reserve * 10^3)
    // The 10^3 adjusts for the decimal difference (9 - 6 = 3)

    let decimal_adjustment = 10u64.pow((SOL_DECIMALS - STABLECOIN_DECIMALS) as u32); // 10^3 = 1000

    let tns_price_usd = (sol_reserve as u128)
        .checked_mul(sol_price_usd as u128)
        .ok_or(TnsError::MathOverflow)?
        .checked_div(tns_reserve as u128)
        .ok_or(TnsError::MathOverflow)?
        .checked_div(decimal_adjustment as u128)
        .ok_or(TnsError::MathOverflow)?;

    Ok(tns_price_usd as u64)
}

/// Calculate TNS amount needed for a given USD amount using pool price
///
/// usd_amount: Amount in micro USD (6 decimals), e.g., 10_000_000 = $10
/// Returns: TNS amount in smallest units (6 decimals)
pub fn calculate_tns_for_usd(
    usd_amount: u64,
    pool_tns_reserve: &AccountInfo,
    pool_sol_reserve: &AccountInfo,
    sol_usd_price_feed: &AccountInfo,
    current_timestamp: i64,
) -> Result<u64> {
    let tns_price_usd = get_tns_price_from_pool(
        pool_tns_reserve,
        pool_sol_reserve,
        sol_usd_price_feed,
        current_timestamp,
    )?;

    // Ensure we don't divide by zero
    require!(tns_price_usd > 0, TnsError::EmptyPoolReserves);

    // tns_needed = usd_amount * STABLECOIN_MULTIPLIER / tns_price_usd
    // Both usd_amount and tns_price_usd are in micro (6 decimals)
    // We multiply by 10^6 to get the token amount in 6 decimal units
    let stablecoin_multiplier = 10u64.pow(STABLECOIN_DECIMALS as u32); // 10^6

    let tns_needed = (usd_amount as u128)
        .checked_mul(stablecoin_multiplier as u128)
        .ok_or(TnsError::MathOverflow)?
        .checked_div(tns_price_usd as u128)
        .ok_or(TnsError::MathOverflow)?;

    Ok(tns_needed as u64)
}
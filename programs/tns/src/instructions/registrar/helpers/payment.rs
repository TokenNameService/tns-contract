use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, transfer_checked, TransferChecked};
use crate::{Config, TNS_DISCOUNT_BPS, STABLECOIN_MULTIPLIER, get_sol_price_micro};

/// Accounts needed for token-based fee transfers (TNS, USDC, USDT)
pub struct TokenFeeTransferAccounts<'a, 'info> {
    pub payer: &'a Signer<'info>,
    pub payer_token_account: &'a InterfaceAccount<'info, TokenAccount>,
    pub vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub token_program: &'a Interface<'info, TokenInterface>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Fee breakdown for SOL payments (requires price conversion)
pub struct SolFeeBreakdown {
    /// Fee in lamports
    pub fee_lamports: u64,
    /// Fixed keeper reward in lamports
    pub keeper_reward_lamports: u64,
}

/// Fee breakdown for token payments (TNS, USDC, USDT)
pub struct TokenFeeBreakdown {
    /// Fee in USD micro-cents
    pub fee_usd_micro: u64,
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

    // Get fee in USD micro-cents, then convert to lamports
    let fee_usd_micro = config.calculate_registration_price_usd(current_time, years);
    let fee_lamports = config.usd_to_lamports(fee_usd_micro, sol_price_micro);

    // Fixed keeper reward from config
    let keeper_reward_lamports = config.get_keeper_reward_lamports();

    Ok(SolFeeBreakdown {
        fee_lamports,
        keeper_reward_lamports,
    })
}

/// Convert USD micro-cents to token raw units (for 6 decimal tokens like USDC/USDT/TNS at $1 peg)
/// 1 USD = 1,000,000 micro-cents
/// 1 token = 1,000,000 raw units = $1
pub fn usd_micro_to_token_amount(usd_micro: u64) -> u64 {
    usd_micro
}

/// Convert USD micro-cents to TNS token amount using oracle price
/// tns_price_micro is the TNS/USD price in micro-cents (e.g., 500_000 = $0.50)
pub fn usd_micro_to_tns_with_oracle(usd_micro: u64, tns_price_micro: u64) -> u64 {
    // usd_micro / tns_price_micro * STABLECOIN_MULTIPLIER
    // Using u128 to prevent overflow
    let token_amount = (usd_micro as u128) * (STABLECOIN_MULTIPLIER as u128) / (tns_price_micro as u128);
    token_amount as u64
}

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
/// Used by: renew_symbol, claim_expired_symbol
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

/// Transfer TNS token fees for registration (with 25% discount, includes keeper reward)
/// 100% of discounted fee goes to treasury in TNS, fixed keeper reward in SOL to Config PDA
/// If tns_price_feed is provided and config has oracle enabled, uses market price
pub fn transfer_tns_registration_fees<'info>(
    accounts: &TokenFeeTransferAccounts<'_, 'info>,
    config_data: &Config,
    fees: &TokenFeeBreakdown,
    tns_price_feed: Option<&AccountInfo<'info>>,
    current_time: i64,
    config: &AccountInfo<'info>,
) -> Result<u64> {
    // Calculate TNS amount based on oracle or $1 peg
    let tns_amount = if config_data.has_tns_oracle() {
        if let Some(price_feed) = tns_price_feed {
            let tns_price_micro = get_sol_price_micro(price_feed, current_time)?;
            usd_micro_to_tns_with_oracle(fees.fee_usd_micro, tns_price_micro)
        } else {
            // Fallback to $1 peg if oracle account not provided
            usd_micro_to_token_amount(fees.fee_usd_micro)
        }
    } else {
        // Pre-oracle: 1 TNS = $1
        usd_micro_to_token_amount(fees.fee_usd_micro)
    };

    // Apply 25% discount
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_treasury_amount = tns_amount - discount;

    // Transfer TNS tokens to vault (100% of discounted amount)
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
        tns_treasury_amount,
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

/// Transfer TNS token fees for renewal or claim (with 25% discount, no keeper reward)
/// 100% of discounted fee goes to treasury in TNS
/// Used by: renew_symbol, claim_expired_symbol
pub fn transfer_tns_renewal_fees<'info>(
    accounts: &TokenFeeTransferAccounts<'_, 'info>,
    config: &Config,
    fee_usd_micro: u64,
    tns_price_feed: Option<&AccountInfo<'info>>,
    current_time: i64,
) -> Result<()> {
    // Calculate TNS amount based on oracle or $1 peg
    let tns_amount = if config.has_tns_oracle() {
        if let Some(price_feed) = tns_price_feed {
            let tns_price_micro = get_sol_price_micro(price_feed, current_time)?;
            usd_micro_to_tns_with_oracle(fee_usd_micro, tns_price_micro)
        } else {
            usd_micro_to_token_amount(fee_usd_micro)
        }
    } else {
        usd_micro_to_token_amount(fee_usd_micro)
    };

    // Apply 25% discount
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_treasury_amount = tns_amount - discount;

    // Transfer TNS tokens to vault (100% of discounted amount)
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
        tns_treasury_amount,
        accounts.mint.decimals,
    )?;

    Ok(())
}

/// Transfer stablecoin (USDC/USDT) fees for registration (no discount, includes keeper reward)
/// 100% of fee goes to treasury, fixed keeper reward in SOL to Config PDA
pub fn transfer_stablecoin_registration_fees<'info>(
    accounts: &TokenFeeTransferAccounts<'_, 'info>,
    fees: &TokenFeeBreakdown,
    config: &AccountInfo<'info>,
) -> Result<u64> {
    // Convert USD to token amount (1 USDC/USDT = $1)
    let token_amount = usd_micro_to_token_amount(fees.fee_usd_micro);

    // Transfer 100% to vault (treasury)
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
        token_amount,
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
/// Used by: renew_symbol, claim_expired_symbol
pub fn transfer_stablecoin_renewal_fees<'info>(
    accounts: &TokenFeeTransferAccounts<'_, 'info>,
    fee_usd_micro: u64,
) -> Result<()> {
    // Convert USD to token amount (1 USDC/USDT = $1)
    let token_amount = usd_micro_to_token_amount(fee_usd_micro);

    // Transfer 100% to vault (treasury)
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
        token_amount,
        accounts.mint.decimals,
    )?;

    Ok(())
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

/// Accounts needed for TNS update fee transfers
pub struct TnsUpdateFeeAccounts<'a, 'info> {
    pub owner: &'a Signer<'info>,
    pub owner_tns_account: &'a InterfaceAccount<'info, TokenAccount>,
    pub tns_vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub tns_mint: &'a InterfaceAccount<'info, Mint>,
    pub token_program: &'a Interface<'info, TokenInterface>,
}

/// Transfer TNS token fee for update_mint (with 25% discount)
pub fn transfer_tns_update_fee<'info>(
    accounts: &TnsUpdateFeeAccounts<'_, 'info>,
    config: &Config,
    fee: &UpdateFeeBreakdown,
    tns_price_feed: Option<&AccountInfo<'info>>,
    current_time: i64,
) -> Result<()> {
    // Calculate TNS amount based on oracle or $1 peg
    let tns_amount = if config.has_tns_oracle() {
        if let Some(price_feed) = tns_price_feed {
            let tns_price_micro = get_sol_price_micro(price_feed, current_time)?;
            usd_micro_to_tns_with_oracle(fee.fee_usd_micro, tns_price_micro)
        } else {
            usd_micro_to_token_amount(fee.fee_usd_micro)
        }
    } else {
        usd_micro_to_token_amount(fee.fee_usd_micro)
    };

    // Apply 25% discount
    let discount = tns_amount * TNS_DISCOUNT_BPS as u64 / 10000;
    let tns_fee = tns_amount - discount;

    transfer_checked(
        CpiContext::new(
            accounts.token_program.to_account_info(),
            TransferChecked {
                from: accounts.owner_tns_account.to_account_info(),
                mint: accounts.tns_mint.to_account_info(),
                to: accounts.tns_vault.to_account_info(),
                authority: accounts.owner.to_account_info(),
            },
        ),
        tns_fee,
        accounts.tns_mint.decimals,
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
    // Convert USD to token amount (1 USDC/USDT = $1)
    let token_amount = usd_micro_to_token_amount(fee.fee_usd_micro);

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
        token_amount,
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

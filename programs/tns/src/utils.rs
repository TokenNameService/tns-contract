use anchor_lang::prelude::*;
use crate::{TnsError, MAX_PRICE_STALENESS_SECONDS, PYTH_MAGIC, PYTH_PROGRAM_ID};

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

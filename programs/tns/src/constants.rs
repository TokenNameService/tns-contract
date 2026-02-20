use anchor_lang::prelude::*;


/// Maximum length for a token symbol (e.g., "BONK", "JUP", "SOL")
pub const MAX_SYMBOL_LENGTH: usize = 10;

/// Maximum years you can register at once (inspired by ICANN standards)
pub const MAX_REGISTRATION_YEARS: u8 = 10;

/// Seconds in a year (365.25 days to account for leap years)
pub const SECONDS_PER_YEAR: i64 = 31_557_600;

/// Grace period after expiration before symbol can be claimed (90 days)
/// 90 Days * 24 hours * 60 minutes * 60 seconds
pub const GRACE_PERIOD_SECONDS: i64 = 90 * 24 * 60 * 60;

/// Cancel period - time after grace period before symbol can be fully canceled (1 year)
/// Total time from expiration to cancelable = 90 days + 365 days = ~455 days
pub const CANCEL_PERIOD_SECONDS: i64 = 365 * 24 * 60 * 60;

/// Base price in USD micro-cents (10_000_000 = $10.00)
/// Using micro-cents (1 USD = 1_000_000 micro-cents) for precision
pub const BASE_PRICE_USD_MICRO: u64 = 10_000_000;

/// Annual price increase in basis points (700 = 7%, inspired by ICANN pricing)
pub const ANNUAL_INCREASE_BPS: u16 = 700;

/// Fixed keeper reward in lamports (0.05 SOL = 50,000,000 lamports)
/// Paid to keepers who close abandoned symbols or detect metadata drift
pub const KEEPER_REWARD_LAMPORTS: u64 = 50_000_000;

/// Fee for updating mint in basis points of base price (5000 = 50%)
pub const UPDATE_FEE_BPS: u16 = 5000;

/// Multi-year discount schedule (basis points off per year)
/// Year 1: 0%, Year 2: 5%, Year 3: 8%, Year 4: 11%, Year 5: 14%
/// Year 6: 16%, Year 7: 18%, Year 8: 20%, Year 9: 22%, Year 10: 25%
pub const MULTI_YEAR_DISCOUNT_BPS: [u16; 10] = [0, 500, 800, 1100, 1400, 1600, 1800, 2000, 2200, 2500];

/// Maximum staleness for Pyth price feed (60 seconds — pull oracle is always fresh)
pub const MAX_PRICE_STALENESS_SECONDS: u64 = 60;

/// Pyth SOL/USD price feed ID (used with pull oracle PriceUpdateV2)
pub const SOL_USD_FEED_ID: [u8; 32] = hex_to_bytes("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");

/// Compile-time hex string to byte array conversion
const fn hex_to_bytes(hex: &str) -> [u8; 32] {
    let bytes = hex.as_bytes();
    let mut result = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        let high = hex_char_to_nibble(bytes[i * 2]);
        let low = hex_char_to_nibble(bytes[i * 2 + 1]);
        result[i] = (high << 4) | low;
        i += 1;
    }
    result
}

const fn hex_char_to_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("invalid hex character"),
    }
}

/// Discount for paying with TNS token in basis points (2500 = 25%)
pub const TNS_DISCOUNT_BPS: u16 = 2500;

/// TNS token mint address on mainnet
pub const TNS_MINT: Pubkey = pubkey!("6jwcLLjhEcUrnnPtnWvqVKEeAzSTXT6qtV1GEjcopump");

/// USDC mint address on mainnet
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// USDT mint address on mainnet
pub const USDT_MINT: Pubkey = pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

/// Stablecoin decimals (USDC, USDT, and TNS all use 6 decimals)
/// 1 token = 1,000,000 raw units = $1
pub const STABLECOIN_DECIMALS: u8 = 6;
pub const STABLECOIN_MULTIPLIER: u64 = 1_000_000;

/// Maximum platform fee in basis points (1000 = 10%)
/// Platforms (launchpads like pump.fun) can receive up to 10% of registration fees
pub const MAX_PLATFORM_FEE_BPS: u16 = 1000;

/// Wrapped SOL mint address
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Pump AMM pool for TNS/SOL pricing
pub const PUMP_TNS_SOL_POOL: Pubkey = pubkey!("4vvoQ1icW9kQJcoqsUxFm9cxyYKJgUHafRo7Bxiyf5Cp");

/// Pool's TNS reserve token account (holds TNS tokens in the pool)
pub const PUMP_POOL_TNS_RESERVE: Pubkey = pubkey!("8UGTQaaDjjWoye9YiG9YuGUc5RHcTb8sHcr877Eg5L73");

/// Pool's SOL reserve token account (holds WSOL tokens in the pool)
pub const PUMP_POOL_SOL_RESERVE: Pubkey = pubkey!("B4PNGmGrdPbPjb2iu7MAKHBovQduv5gjLJdC9i5UNQaJ");

/// SOL decimals (9 decimals)
pub const SOL_DECIMALS: u8 = 9;

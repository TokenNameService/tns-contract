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

/// Fixed keeper reward in lamports (0.01 SOL = 10,000,000 lamports)
/// This is a flat fee paid to the symbol account for whoever cranks expiration
pub const KEEPER_REWARD_LAMPORTS: u64 = 10_000_000;

/// Fee for updating mint in basis points of base price (5000 = 50%)
pub const UPDATE_FEE_BPS: u16 = 5000;

/// Multi-year discount schedule (basis points off per year)
/// Year 1: 0%, Year 2: 5%, Year 3: 8%, Year 4: 11%, Year 5: 14%
/// Year 6: 16%, Year 7: 18%, Year 8: 20%, Year 9: 22%, Year 10: 25%
pub const MULTI_YEAR_DISCOUNT_BPS: [u16; 10] = [0, 500, 800, 1100, 1400, 1600, 1800, 2000, 2200, 2500];

/// Maximum staleness for Pyth price feed (1 hour)
pub const MAX_PRICE_STALENESS_SECONDS: i64 = 3600;

/// Pyth magic number for price accounts
pub const PYTH_MAGIC: u32 = 0xa1b2c3d4;

/// Pyth program ID on mainnet (owner of price feed accounts)
pub const PYTH_PROGRAM_ID: Pubkey = pubkey!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

/// Discount for paying with TNS token in basis points (2500 = 25%)
pub const TNS_DISCOUNT_BPS: u16 = 2500;

/// TNS token mint address on mainnet (TODO: replace with real address before launch)
pub const TNS_MINT: Pubkey = pubkey!("11111111111111111111111111111111");

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

/**
 * Generate Rust code from reserved symbol JSON files
 *
 * This reads the JSON files in priority order and generates phf::Set definitions.
 * Symbols that appear in higher-priority lists are COMMENTED OUT in lower-priority
 * lists to avoid duplicate on-chain storage while maintaining transparency.
 *
 * Priority order:
 *   1. Dow Jones (30 blue chips)
 *   2. S&P 500 (large cap)
 *   3. S&P 400 (mid cap)
 *   4. S&P 600 (small cap)
 *   5. NASDAQ 100 (tech-heavy)
 *   6. FMP Stocks (everything else - international, OTC, REITs, etc.)
 *   7. FMP ETFs (if included)
 *
 * Usage:
 *   npx tsx scripts/reserved/generateRustCode.ts              # Full lists (Phase 3)
 *   npx tsx scripts/reserved/generateRustCode.ts --phase1     # Minimal lists (Phase 1 - saves rent)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface JsonData {
  name: string;
  source: string;
  sourceType: string;
  fetchedAt: string;
  count: number;
  symbols: Array<{
    symbol: string;
    name: string;
    sector?: string;
    industry?: string;
    exchange?: string;
  }>;
}

// Priority order - earlier = higher priority
const SOURCES = [
  {
    file: "dow.json",
    rustName: "DOW_SYMBOLS",
    displayName: "Dow Jones Industrial Average",
  },
  { file: "sp500.json", rustName: "SP500_SYMBOLS", displayName: "S&P 500" },
  {
    file: "sp400.json",
    rustName: "SP400_SYMBOLS",
    displayName: "S&P 400 Mid Cap",
  },
  {
    file: "sp600.json",
    rustName: "SP600_SYMBOLS",
    displayName: "S&P 600 Small Cap",
  },
  {
    file: "nasdaq100.json",
    rustName: "NASDAQ100_SYMBOLS",
    displayName: "NASDAQ 100",
  },
  {
    file: "fmp-stocks.json",
    rustName: "FMP_OTHER_SYMBOLS",
    displayName: "FMP Other Stocks (International, OTC, REITs, etc.)",
  },
  {
    file: "fmp-etfs.json",
    rustName: "FMP_ETF_SYMBOLS",
    displayName: "FMP ETFs",
  },
];

function loadJson(filePath: string): JsonData | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

function escapeRustString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function main() {
  const dataDir = join(__dirname, "data");
  const seenSymbols = new Set<string>();
  const phase1Mode = process.argv.includes("--phase1");

  if (phase1Mode) {
    console.log("\n🚀 Phase 1 Mode: Generating minimal lists to save rent\n");
    console.log(
      "   Only first symbol per list will be active, rest commented out.\n"
    );
  }

  const phase1Header = phase1Mode
    ? `//!
//! ⚠️  PHASE 1 MODE: Most symbols are commented out to minimize program size and rent.
//!     Admin manually controls registrations during Phase 1.
//!     Run \`npm run generate:reserved\` (without --phase1) for full lists in Phase 3.
//!
`
    : "";

  let rustCode = `//! Auto-generated reserved symbol lists
//!
//! Generated: ${new Date().toISOString()}
//!
//! These symbols are reserved for TradFi assets and cannot be registered
//! until Phase 3 (RWA tokenization).
${phase1Header}//!
//! Priority order (duplicates commented out in lower-priority lists):
//!   1. Dow Jones (30 blue chips)
//!   2. S&P 500 (large cap)
//!   3. S&P 400 (mid cap)
//!   4. S&P 600 (small cap)
//!   5. NASDAQ 100 (tech-heavy)
//!   6. FMP Other (international, OTC, REITs, etc.)
//!   7. FMP ETFs

use phf::phf_set;

`;

  const stats: Array<{
    name: string;
    total: number;
    active: number;
    commented: number;
    phase1Commented: number;
  }> = [];

  for (const source of SOURCES) {
    const filePath = join(dataDir, source.file);
    const data = loadJson(filePath);

    if (!data) {
      console.log(`  Skipping ${source.file} (not found)`);
      continue;
    }

    console.log(`  Processing ${source.file}...`);

    // Separate into active and commented (duplicates)
    const activeSymbols: string[] = [];
    const commentedSymbols: Array<{ symbol: string; reason: string }> = [];
    const phase1Commented: string[] = []; // Symbols commented out for Phase 1 rent savings

    for (const item of data.symbols) {
      const symbol = item.symbol.toUpperCase();

      if (seenSymbols.has(symbol)) {
        commentedSymbols.push({
          symbol,
          reason: "duplicate from higher-priority list",
        });
      } else {
        // In Phase 1 mode, only keep the first symbol active per list
        if (phase1Mode && activeSymbols.length >= 1) {
          phase1Commented.push(symbol);
        } else {
          activeSymbols.push(symbol);
        }
        seenSymbols.add(symbol);
      }
    }

    stats.push({
      name: source.displayName,
      total: data.symbols.length,
      active: activeSymbols.length,
      commented: commentedSymbols.length,
      phase1Commented: phase1Commented.length,
    });

    // Generate the phf_set
    rustCode += `/// ${source.displayName}\n`;
    rustCode += `/// Source: ${data.source}\n`;
    rustCode += `/// Fetched: ${data.fetchedAt}\n`;
    if (phase1Mode) {
      rustCode += `/// Total: ${data.symbols.length}, Active: ${activeSymbols.length}, Phase1 Commented: ${phase1Commented.length}, Duplicates: ${commentedSymbols.length}\n`;
    } else {
      rustCode += `/// Total: ${data.symbols.length}, Active: ${activeSymbols.length}, Commented: ${commentedSymbols.length}\n`;
    }
    rustCode += `pub static ${source.rustName}: phf::Set<&'static str> = phf_set! {\n`;

    // Add active symbols
    for (const symbol of activeSymbols.sort()) {
      rustCode += `    "${escapeRustString(symbol)}",\n`;
    }

    rustCode += `};\n\n`;

    // Add Phase 1 commented symbols (for rent savings, will be enabled in Phase 3)
    if (phase1Commented.length > 0) {
      rustCode += `// Phase 1: ${phase1Commented.length} symbols commented to save rent (enable in Phase 3):\n`;
      for (const symbol of phase1Commented.sort()) {
        rustCode += `// "${escapeRustString(symbol)}",\n`;
      }
      rustCode += `\n`;
    }

    // Add commented duplicates as documentation
    if (commentedSymbols.length > 0) {
      rustCode += `// Duplicates from ${source.displayName} (already in higher-priority list):\n`;
      for (const { symbol } of commentedSymbols.sort((a, b) =>
        a.symbol.localeCompare(b.symbol)
      )) {
        rustCode += `// "${escapeRustString(symbol)}",\n`;
      }
      rustCode += `\n`;
    }
  }

  // Generate the check functions
  rustCode += `/// Check if a symbol is in any reserved list
pub fn is_reserved(symbol: &str) -> bool {
    let upper = symbol.to_uppercase();
    let s = upper.as_str();

    DOW_SYMBOLS.contains(s)
        || SP500_SYMBOLS.contains(s)
        || SP400_SYMBOLS.contains(s)
        || SP600_SYMBOLS.contains(s)
        || NASDAQ100_SYMBOLS.contains(s)
        || FMP_OTHER_SYMBOLS.contains(s)
        || FMP_ETF_SYMBOLS.contains(s)
}

/// Check which list a symbol belongs to (returns first match by priority)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReservedList {
    Dow,
    Sp500,
    Sp400,
    Sp600,
    Nasdaq100,
    FmpOther,
    FmpEtf,
}

pub fn get_reserved_list(symbol: &str) -> Option<ReservedList> {
    let upper = symbol.to_uppercase();
    let s = upper.as_str();

    if DOW_SYMBOLS.contains(s) {
        Some(ReservedList::Dow)
    } else if SP500_SYMBOLS.contains(s) {
        Some(ReservedList::Sp500)
    } else if SP400_SYMBOLS.contains(s) {
        Some(ReservedList::Sp400)
    } else if SP600_SYMBOLS.contains(s) {
        Some(ReservedList::Sp600)
    } else if NASDAQ100_SYMBOLS.contains(s) {
        Some(ReservedList::Nasdaq100)
    } else if FMP_OTHER_SYMBOLS.contains(s) {
        Some(ReservedList::FmpOther)
    } else if FMP_ETF_SYMBOLS.contains(s) {
        Some(ReservedList::FmpEtf)
    } else {
        None
    }
}
`;

  // Write the Rust file
  const rustDir = join(__dirname, "../../programs/tns/src/whitelist");
  const rustPath = join(rustDir, "reserved.rs");
  writeFileSync(rustPath, rustCode);
  console.log(`\nWrote Rust code to: ${rustPath}`);

  // Print summary
  console.log("\n=== Summary ===\n");
  let totalActive = 0;
  let totalCommented = 0;
  let totalPhase1Commented = 0;

  for (const stat of stats) {
    console.log(`  ${stat.name}:`);
    if (phase1Mode) {
      console.log(
        `    Total: ${stat.total}, Active: ${stat.active}, Phase1 Commented: ${stat.phase1Commented}, Duplicates: ${stat.commented}`
      );
    } else {
      console.log(
        `    Total: ${stat.total}, Active: ${stat.active}, Commented: ${stat.commented}`
      );
    }
    totalActive += stat.active;
    totalCommented += stat.commented;
    totalPhase1Commented += stat.phase1Commented;
  }

  console.log(`\n  Overall:`);
  console.log(`    Active symbols (on-chain): ${totalActive}`);
  if (phase1Mode) {
    console.log(
      `    Phase 1 commented (rent savings): ${totalPhase1Commented}`
    );
  }
  console.log(`    Duplicates commented: ${totalCommented}`);
  console.log(`    Total unique: ${seenSymbols.size}`);

  if (phase1Mode) {
    console.log(
      `\n  💰 Estimated rent savings: ~${(
        (totalPhase1Commented * 50) /
        1_000_000
      ).toFixed(2)} MB less program size`
    );
  }
}

main();

export interface WikiAsset {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
}

export interface FmpAsset {
  symbol: string;
  name: string;
  price: number | null;
  exchange: string;
  exchangeShortName: string;
  type: string;
}

export type IndexName = "dow" | "sp500" | "sp400" | "sp600" | "nasdaq100";

export interface ReservedSymbol {
  symbol: string;
  name: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  type?: string;
  indexes: IndexName[];
  priority: number; // Lower = higher priority (1 = Dow, 2 = S&P 500, etc.)
}

export interface ReservedSymbolsOutput {
  fetchedAt: string;
  totalCount: number;
  indexCounts: Record<IndexName, number>;
  fmpCount: number;
  symbols: ReservedSymbol[];
}

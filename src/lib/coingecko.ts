/**
 * Shared CoinGecko API configuration with auto-detection of key type (demo vs pro).
 *
 * Adapted from the App's src/lib/coingecko.ts with one key difference:
 * supports missing API key (returns unauthenticated demo config).
 *
 * Set COINGECKO_API_TYPE=pro|demo to skip detection entirely (no ping ever).
 *
 * When unset, pings the pro endpoint once and caches the result:
 * - 200 → pro key, cached for the process lifetime (never re-pinged)
 * - 400/401/403 with error code 10010/10011 → demo key, cached for the process lifetime
 * - 429/5xx/network error → inconclusive; use previous result and retry with
 *   exponential backoff (5 min, doubling, capped at 1 hour)
 */

export interface CoingeckoConfig {
  baseUrl: string;
  headerKey: string | null;
  apiKey: string | null;
}

const PRO_CONFIG = {
  baseUrl: "https://pro-api.coingecko.com/api/v3",
  headerKey: "x-cg-pro-api-key",
} as const;

const DEMO_CONFIG = {
  baseUrl: "https://api.coingecko.com/api/v3",
  headerKey: "x-cg-demo-api-key",
} as const;

const BASE_INCONCLUSIVE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_INCONCLUSIVE_TTL = 60 * 60 * 1000; // 1 hour

let cached: {
  config: { baseUrl: string; headerKey: string };
  expires: number;
} | null = null;
let inflight: Promise<{ baseUrl: string; headerKey: string }> | null = null;
// Consecutive inconclusive detections. Drives the exponential backoff on the
// in-memory expiry; reset to 0 on any confirmed (pro/demo) result.
let inconclusiveStreak = 0;
// One-time guard so an invalid COINGECKO_API_TYPE only warns once.
let warnedInvalidApiType = false;

// Backoff expiry for an inconclusive detection: 5 min, doubling per streak,
// capped at 1 hour. Uses the current streak (before increment) so the first
// inconclusive result waits the base 5 min.
function inconclusiveExpiry(): number {
  const ttl = Math.min(
    BASE_INCONCLUSIVE_TTL * 2 ** inconclusiveStreak,
    MAX_INCONCLUSIVE_TTL
  );
  return Date.now() + ttl;
}

async function detect(
  apiKey: string
): Promise<{ baseUrl: string; headerKey: string }> {
  try {
    const res = await fetch("https://pro-api.coingecko.com/api/v3/ping", {
      headers: { "x-cg-pro-api-key": apiKey, accept: "application/json" },
    });

    if (res.ok) {
      console.log("[coingecko] Detected API type: pro");
      inconclusiveStreak = 0;
      cached = { config: PRO_CONFIG, expires: Infinity };
      return PRO_CONFIG;
    }

    // Check for explicit wrong-key error codes
    const isDemoKey = await (async () => {
      try {
        const body = await res.json();
        const code = body?.status?.error_code;
        return code === 10010 || code === 10011;
      } catch {
        // If we can't parse JSON, fall through to status-based check
        return res.status === 401 || res.status === 403;
      }
    })();

    if (isDemoKey) {
      console.log("[coingecko] Detected API type: demo");
      inconclusiveStreak = 0;
      cached = { config: DEMO_CONFIG, expires: Infinity };
      return DEMO_CONFIG;
    }

    // Transient error (429, 5xx, etc.) — inconclusive, exponential backoff
    const expires = inconclusiveExpiry();
    inconclusiveStreak += 1;
    console.log(
      `[coingecko] Detection inconclusive (HTTP ${res.status}), will retry in ~${Math.round((expires - Date.now()) / 60000)} min`
    );
    if (cached) {
      cached = { ...cached, expires };
      return cached.config;
    }
    // No previous result — default to demo
    cached = { config: DEMO_CONFIG, expires };
    return DEMO_CONFIG;
  } catch (err) {
    // Network error — inconclusive, exponential backoff
    const expires = inconclusiveExpiry();
    inconclusiveStreak += 1;
    console.log(
      `[coingecko] Detection failed (network error), will retry in ~${Math.round((expires - Date.now()) / 60000)} min`
    );
    if (cached) {
      cached = { ...cached, expires };
      return cached.config;
    }
    cached = { config: DEMO_CONFIG, expires };
    return DEMO_CONFIG;
  }
}

export async function getCoingeckoConfig(): Promise<CoingeckoConfig> {
  const apiKey = process.env.COINGECKO_API_KEY ?? null;

  // Explicit override — skip ping-based detection entirely. headerKey follows
  // the same present-only rule as the rest of the code (no key → no header).
  const apiType = process.env.COINGECKO_API_TYPE?.toLowerCase();
  if (apiType === "pro") {
    return {
      baseUrl: PRO_CONFIG.baseUrl,
      headerKey: apiKey ? PRO_CONFIG.headerKey : null,
      apiKey,
    };
  }
  if (apiType === "demo") {
    return {
      baseUrl: DEMO_CONFIG.baseUrl,
      headerKey: apiKey ? DEMO_CONFIG.headerKey : null,
      apiKey,
    };
  }
  if (apiType !== undefined && apiType !== "" && !warnedInvalidApiType) {
    console.warn(
      `[coingecko] Ignoring invalid COINGECKO_API_TYPE="${process.env.COINGECKO_API_TYPE}" (expected "pro" or "demo"); falling back to auto-detection`
    );
    warnedInvalidApiType = true;
  }

  // No API key — use demo URL without auth headers
  if (!apiKey) {
    return {
      baseUrl: DEMO_CONFIG.baseUrl,
      headerKey: null,
      apiKey: null,
    };
  }

  // Return cached if still valid (confirmed results never expire)
  if (cached && cached.expires > Date.now()) {
    return { ...cached.config, apiKey };
  }

  // Deduplicate concurrent callers
  if (!inflight) {
    inflight = detect(apiKey).finally(() => {
      inflight = null;
    });
  }

  const config = await inflight;
  return { ...config, apiKey };
}

/**
 * Shared CoinGecko API configuration with auto-detection of key type (demo vs pro).
 *
 * Adapted from the App's src/lib/coingecko.ts with one key difference:
 * supports missing API key (returns unauthenticated demo config).
 *
 * Pings the pro endpoint once and caches the result:
 * - 200 → pro key, cached 1 hour
 * - 400/401/403 with error code 10010/10011 → demo key, cached 1 hour
 * - 429/5xx/network error → inconclusive, use previous result, retry in 5 min
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

const CONFIRMED_TTL = 60 * 60 * 1000; // 1 hour
const INCONCLUSIVE_TTL = 5 * 60 * 1000; // 5 minutes

let cached: {
  config: { baseUrl: string; headerKey: string };
  expires: number;
} | null = null;
let inflight: Promise<{ baseUrl: string; headerKey: string }> | null = null;

async function detect(
  apiKey: string
): Promise<{ baseUrl: string; headerKey: string }> {
  try {
    const res = await fetch("https://pro-api.coingecko.com/api/v3/ping", {
      headers: { "x-cg-pro-api-key": apiKey, accept: "application/json" },
    });

    if (res.ok) {
      console.log("[coingecko] Detected API type: pro");
      cached = { config: PRO_CONFIG, expires: Date.now() + CONFIRMED_TTL };
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
      cached = { config: DEMO_CONFIG, expires: Date.now() + CONFIRMED_TTL };
      return DEMO_CONFIG;
    }

    // Transient error (429, 5xx, etc.) — inconclusive
    console.log(
      `[coingecko] Detection inconclusive (HTTP ${res.status}), will retry in 5 min`
    );
    if (cached) {
      cached = { ...cached, expires: Date.now() + INCONCLUSIVE_TTL };
      return cached.config;
    }
    // No previous result — default to demo
    cached = { config: DEMO_CONFIG, expires: Date.now() + INCONCLUSIVE_TTL };
    return DEMO_CONFIG;
  } catch (err) {
    // Network error — inconclusive
    console.log(
      "[coingecko] Detection failed (network error), will retry in 5 min"
    );
    if (cached) {
      cached = { ...cached, expires: Date.now() + INCONCLUSIVE_TTL };
      return cached.config;
    }
    cached = { config: DEMO_CONFIG, expires: Date.now() + INCONCLUSIVE_TTL };
    return DEMO_CONFIG;
  }
}

export async function getCoingeckoConfig(): Promise<CoingeckoConfig> {
  const apiKey = process.env.COINGECKO_API_KEY;

  // No API key — use demo URL without auth headers
  if (!apiKey) {
    return {
      baseUrl: DEMO_CONFIG.baseUrl,
      headerKey: null,
      apiKey: null,
    };
  }

  // Return cached if still valid
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

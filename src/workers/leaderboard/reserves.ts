import type { PublicClient } from "viem";

export interface VaultReserves {
  reserveApes: bigint;
  reserveLPers: bigint;
  tickPriceX42: bigint;
}

const ASSISTANT_GET_RESERVES_ABI = [
  {
    type: "function",
    name: "getReserves",
    inputs: [{ name: "vaultIds", type: "uint48[]" }],
    outputs: [
      {
        name: "reserves",
        type: "tuple[]",
        components: [
          { name: "reserveApes", type: "uint144" },
          { name: "reserveLPers", type: "uint144" },
          { name: "tickPriceX42", type: "int64" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

/**
 * Calls Assistant.getReserves(vaultIds) with split-on-failure recovery.
 * On RPC timeout or revert with multiple vaults, splits the array in half
 * and retries each half. Single-vault failures are logged and omitted from
 * the result map; callers already gracefully skip vaults with missing reserves.
 */
export async function getReservesResilient(
  client: PublicClient,
  assistantAddress: `0x${string}`,
  vaultIds: number[],
  chainId: number
): Promise<Map<number, VaultReserves>> {
  const result = new Map<number, VaultReserves>();
  if (vaultIds.length === 0) return result;

  try {
    const reserves = await client.readContract({
      address: assistantAddress,
      abi: ASSISTANT_GET_RESERVES_ABI,
      functionName: "getReserves",
      args: [vaultIds],
    });
    for (let i = 0; i < vaultIds.length; i++) {
      const r = reserves[i];
      if (r) {
        result.set(vaultIds[i], {
          reserveApes: r.reserveApes,
          reserveLPers: r.reserveLPers,
          tickPriceX42: r.tickPriceX42,
        });
      }
    }
    return result;
  } catch (error) {
    if (vaultIds.length === 1) {
      const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.warn(
        `[Reserves] Chain ${chainId}: getReserves failed for vault ${vaultIds[0]}: ${msg}`
      );
      return result;
    }
    const mid = Math.floor(vaultIds.length / 2);
    const [left, right] = await Promise.all([
      getReservesResilient(client, assistantAddress, vaultIds.slice(0, mid), chainId),
      getReservesResilient(client, assistantAddress, vaultIds.slice(mid), chainId),
    ]);
    for (const [k, v] of left) result.set(k, v);
    for (const [k, v] of right) result.set(k, v);
    return result;
  }
}

import { defineChain } from 'viem';
import { RPC_URL, IS_LOCAL } from './pay';

/**
 * Arc mainnet, chain 5042. USDC is the gas token, so a transfer costs nothing
 * in the network fee — which is what makes leaving a request free.
 *
 * In development the same chain id points at a local node, so the app and the
 * tests exercise an identical code path.
 */
export const arc = defineChain({
  id: 5042,
  name: IS_LOCAL ? 'Arc (local)' : 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: IS_LOCAL
    ? undefined
    : { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
  testnet: IS_LOCAL,
});
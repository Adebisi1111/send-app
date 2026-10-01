// Contract addresses + tiny read helpers for the request/release app.
// Deployed on Arc testnet.

export const USDC = '0x3600000000000000000000000000000000000000' as const;
export const REGISTRY = '0x9e15EEF785340AAECA386d3099404D5c50FA7CF5' as const;
export const REQUESTS = '0x5A531DC4E63EbB98aE8c44411122A54808a35e5a' as const;

export const REGISTRY_ABI = [
  'function register(string)',
  'function resolve(string) view returns (address)',
  'function usernameOf(address) view returns (string)',
  'function isTaken(string) view returns (bool)',
] as const;

export const REQUEST_ABI = [
  'function requestFor(string,string,uint256,uint256,bool) returns (uint256)',
  'function release(uint256)',
  'function cancel(uint256)',
  'function refundExpired(uint256)',
  'function getRequest(uint256) view returns (uint256 id, address requester, address recipient, string username, string purpose, uint256 amount, uint256 expiresAt, uint8 status, bool autoRelease)',
  'function inbox(address) view returns (uint256[])',
  'function outbox(address) view returns (uint256[])',
  'function outstanding() view returns (uint256)',
] as const;

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
] as const;

export const STATUS = ['None', 'Pending', 'Released', 'Cancelled', 'Refunded'] as const;
export type Status = (typeof STATUS)[number];

export interface Request {
  id: bigint;
  requester: `0x${string}`;
  recipient: `0x${string}`;
  username: string;
  purpose: string;
  amount: bigint;
  expiresAt: bigint;
  status: number;
  autoRelease: boolean;
}

export const usdc = (v: bigint): number => Number(v) / 1e6;
export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const DAY = 86_400;

// Contract addresses + ABIs for the request/release app.
// Deployed on Arc mainnet (chain 5042).
import { parseAbi } from 'viem';

// Native USDC on Arc — same address on mainnet and testnet, and also the gas token.
export const USDC = '0x3600000000000000000000000000000000000000' as const;
export const REGISTRY = '0x71508725F355cf017B42Bccd878cff3c8a0bE641' as const;
export const REQUESTS = '0x285223c45050D7c93b8fF93Cc972580D2DD1f2EF' as const;

const REGISTRY_ABI_SIG = [
  'function register(string)',
  'function resolve(string) view returns (address)',
  'function usernameOf(address) view returns (string)',
  'function isTaken(string) view returns (bool)',
] as const;

export const REGISTRY_ABI = parseAbi(REGISTRY_ABI_SIG);

const REQUEST_ABI_SIG = [
  'function requestFor(string,string,uint256,uint256,bool) returns (uint256)',
  'function release(uint256)',
  'function cancel(uint256)',
  'function refundExpired(uint256)',
  'function getRequest(uint256) view returns (uint256 id, address requester, address recipient, string username, string purpose, uint256 amount, uint256 expiresAt, uint8 status, bool autoRelease)',
  'function inbox(address) view returns (uint256[])',
  'function outbox(address) view returns (uint256[])',
  'function outstanding() view returns (uint256)',
] as const;

const ERC20_ABI_SIG = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
] as const;

export const REQUEST_ABI = parseAbi(REQUEST_ABI_SIG);
export const ERC20_ABI = parseAbi(ERC20_ABI_SIG);

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

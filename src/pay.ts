// Addresses and ABIs for the ask-then-pay app.
// A requester asks someone for USDC. Nothing is escrowed: the payer sends
// their own USDC when they settle it, and anyone may settle — including
// several people chipping into the same request.
//
// Network defaults to a local Arc chain for development. Set VITE_RPC and
// the contract addresses to point at a real deployment.
import { parseAbi } from 'viem';

export const RPC_URL = import.meta.env.VITE_RPC ?? 'https://rpc.mainnet.arc.io';
export const IS_LOCAL = RPC_URL.includes('127.0.0.1');

export const USDC = (import.meta.env.VITE_USDC ?? '0x3600000000000000000000000000000000000000') as `0x${string}`;
export const REGISTRY = (import.meta.env.VITE_REGISTRY ?? '0x71508725F355cf017B42Bccd878cff3c8a0bE641') as `0x${string}`;
export const REQUESTS = (import.meta.env.VITE_REQUESTS ?? '0xe71c9a722605ff6541d659a685f968349624e075') as `0x${string}`;

const REGISTRY_ABI_SIG = [
  'function register(string) returns (string)',
  'function resolve(string) view returns (address)',
  'function usernameOf(address) view returns (string)',
  'function isTaken(string) view returns (bool)',
  'function transferUsername(address)',
] as const;

export const REGISTRY_ABI = parseAbi(REGISTRY_ABI_SIG);

const REQUEST_ABI_SIG = [
  'function ask(string,string,uint256,uint256) returns (uint256)',
  'function askAnyone(string,uint256,uint256) returns (uint256)',
  'function pay(uint256,uint256)',
  'function payRemaining(uint256) returns (uint256)',
  'function cancel(uint256)',
  'function decline(uint256)',
  'function canRespond(uint256,address) view returns (bool)',
  'function close(uint256)',
  'function remaining(uint256) view returns (uint256)',
  'function isSettled(uint256) view returns (bool)',
  'function paidBy(uint256,address) view returns (uint256)',
  'function openRequests(uint256) view returns (uint256[])',
  'function askedOf(address) view returns (uint256[])',
  'function openedBy(address) view returns (uint256[])',
  'function feedOf(address,uint256) view returns (uint256[])',
  'function statusOf(uint256) view returns (uint8)',
  'function nextId() view returns (uint256)',
  'function openUnnamedCount() view returns (uint256)',
  'function totalSettled() view returns (uint256)',
  'function getRequest(uint256) view returns (uint256 id, address requester, address named, string username, string purpose, uint256 amount, uint256 collected, uint64 expiresAt, uint8 status)',
  'event Settled(uint256 indexed id, address indexed payer, uint256 amount, uint256 collected, uint256 total)',
  'event RequestOpened(uint256 indexed id, address indexed requester, address indexed named, string username, string purpose, uint256 amount, uint64 expiresAt)',
] as const;

const ERC20_ABI_SIG = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
] as const;

export const REQUEST_ABI = parseAbi(REQUEST_ABI_SIG);
export const ERC20_ABI = parseAbi(ERC20_ABI_SIG);

/// Open=1, Paid=2, Cancelled=3, Declined=4
export const STATUS = ['None', 'Open', 'Paid', 'Cancelled', 'Declined'] as const;
export type Status = (typeof STATUS)[number];

export interface Request {
  id: bigint;
  requester: `0x${string}`; // who is owed
  named: `0x${string}`; // who was asked; zero means open to anyone
  username: string;
  purpose: string;
  amount: bigint;
  collected: bigint;
  expiresAt: bigint;
  status: number;
}

export const ZERO = '0x0000000000000000000000000000000000000000' as const;

export const usdc = (v: bigint): number => Number(v) / 1e6;

/** Format a USDC amount: 4 dp, trailing zeros trimmed. */
export const fmtUsdc = (v: bigint): string =>
  (Number(v) / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const DAY = 86_400;

/** How much is still needed to settle this request. */
export const remaining = (r: Request): bigint => r.amount - r.collected;
export const isOpen = (r: Request): boolean => r.status === 1;
/** An open request that named nobody — anyone can fulfil it. */
export const isOpenRequest = (r: Request): boolean => isOpen(r) && r.named === ZERO;
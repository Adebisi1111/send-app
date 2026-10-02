// Addresses and ABIs for the ask-then-pay app.
// A requester asks someone for USDC. Nothing is escrowed: the payer sends
// their own USDC when they settle it, and anyone may settle — including
// several people chipping into the same request.
//
// Network defaults to a local Arc chain for development. Set VITE_RPC and
// the contract addresses to point at a real deployment.
import { parseAbi } from 'viem';

const LOCAL = 'http://127.0.0.1:8545';

export const RPC_URL = import.meta.env.VITE_RPC ?? LOCAL;
export const IS_LOCAL = RPC_URL.includes('127.0.0.1');

export const USDC = (import.meta.env.VITE_USDC ?? '0x5FbDB2315678afecb367f032d93F642f64180aa3') as `0x${string}`;
export const REGISTRY = (import.meta.env.VITE_REGISTRY ?? '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512') as `0x${string}`;
export const REQUESTS = (import.meta.env.VITE_REQUESTS ?? '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0') as `0x${string}`;

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

/// Open=1, Paid=2, Cancelled=3
export const STATUS = ['None', 'Open', 'Paid', 'Cancelled'] as const;
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
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

/**
 * USDC has 6 decimals, so amounts can legitimately be smaller than a thousandth
 * of a cent. Round to 6 and strip trailing zeros; anything finer than 1e-6 is
 * not representable and shows as zero.
 */
export const fmtUsdc = (v: bigint): string =>
  (Number(v) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Addresses read from the chain by the raw decoder come back lowercase, while
 * wagmi hands back EIP-55 checksummed. Comparing them with === never matches,
 * so anything gated on "is this me" silently fails. Normalise before comparing.
 */
export const sameAddress = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * viem and several wallets both surface a bare "Http request failed" for what
 * are several different problems. Those are the common ones and what to do
 * about them; anything else is passed through untouched so a real revert reason
 * is never swallowed.
 */
export const explain = (e: unknown): string => {
  const m = e as { shortMessage?: string; message?: string; name?: string } | null;
  const raw = m?.shortMessage ?? m?.message ?? '';
  const s = String(raw);

  if (/http request failed|fetch failed|network ?error|failed to fetch/i.test(s)) {
    // Reads go through this app's RPC and succeed, so a failure here is the
    // wallet's own endpoint for Arc. That is the confusing case: it looks like
    // the whole app is offline when only the wallet's route is.
    return 'Your wallet cannot reach Arc. Its Arc RPC may be unreachable. Open the wallet settings, find Arc mainnet, and set the RPC URL to https://rpc.mainnet.arc.io';
  }
  if (/user (rejected|denied)|rejected the request/i.test(s)) {
    return 'You cancelled that in your wallet.';
  }
  // Anchored on the gas wording on purpose: a bare "insufficient funds" is
  // also what an ERC-20 balance error looks like, and that one must survive
  // with its own reason intact.
  if (/insufficient funds for (gas|gas \* price)|gas required|intrinsic gas too low/i.test(s)) {
    return 'Not enough USDC in this wallet to cover the fee. Arc uses USDC for gas, so the wallet needs a small balance first.';
  }
  if (/already taken|already registered|taken/i.test(s)) {
    return 'That username is already taken. Try another.';
  }
  if (/unauthorized|not authorised|not authorized|signature/i.test(s)) {
    return 'Your wallet refused to sign. Open the wallet and approve the transaction.';
  }
  if (!s) return 'Something went wrong. Try again.';
  return s;
};

export const DAY = 86_400;

/** How much is still needed to settle this request. */
export const remaining = (r: Request): bigint => r.amount - r.collected;
export const isOpen = (r: Request): boolean => r.status === 1;
/** An open request that named nobody — anyone can fulfil it. */
export const isOpenRequest = (r: Request): boolean => isOpen(r) && sameAddress(r.named, ZERO);

/**
 * Merge the requests a person was asked for with the open feed into the single
 * list the Requests tab shows. A request addressed to you by name comes first,
 * because it is yours to answer; open requests anyone can settle follow, newest
 * first. Deduplicated by id, since a request can appear in both.
 */
/**
 * Which side of a request the connected account is on. The wording and the
 * controls both depend on it, and getting it wrong shows someone a request
 * they made as though it had been made of them.
 */
export type Direction = 'asking' | 'asked-of-me';

export const directionOf = (r: Request, me: string): Direction =>
  r.requester.toLowerCase() === me.toLowerCase() ? 'asking' : 'asked-of-me';

export const mergeActionable = (named: Request[], open: Request[]): Request[] => {
  const seen = new Set<string>();
  const out: Request[] = [];
  for (const r of [...named, ...open]) {
    const k = r.id.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort((a, b) => {
    const ao = isOpenRequest(a) ? 1 : 0;
    const bo = isOpenRequest(b) ? 1 : 0;
    return ao !== bo ? ao - bo : Number(b.id - a.id);
  });
};
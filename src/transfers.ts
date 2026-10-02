/**
 * Reading an account's direct USDC transfers, so History can show a plain Send
 * and not only requests.
 *
 * Four properties of Arc's public RPC, each verified against the node rather
 * than assumed:
 *
 *   1. `topics` must be `[signature]` or `[signature, address]`. A bare
 *      two-element array is rejected, and so is a wildcard in the third slot,
 *      both with -32602 "Invalid params". There is no server-side filtering on
 *      both parties, so the counterparty is matched client-side.
 *   2. The node rate-limits bursts with -32005. Windows are walked newest-first
 *      and a refused window stops the scan rather than throwing away what was
 *      already collected, so recent sends always appear even when an old one
 *      falls outside the scanned range.
 *   3. Arc emits every USDC transfer twice: once from a system emitter and once
 *      from the USDC contract. Only the USDC contract's own log is kept, and
 *      entries are keyed by transaction hash, which is what stops every send
 *      appearing twice.
 *   4. Transfer amounts are in the token's own units. USDC has six decimals, so
 *      a raw 1400 is 0.0014 USDC and not 1400.
 */
import { USDC, RPC_URL } from './pay';

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type DirectTransfer = {
  hash: string;
  block: number;
  /** true when the connected account sent it */
  outgoing: boolean;
  /** the other party */
  counterparty: string;
  /** amount in whole USDC */
  amount: number;
};

type RpcLog = {
  address: string;
  blockNumber: string;
  transactionHash: string;
  topics: string[];
  data: string;
};

const hex = (n: number): string => `0x${n.toString(16)}`;



async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? `${method} failed`);
  return json.result as T;
}

async function headBlock(): Promise<number> {
  const r = await rpc<string>('eth_blockNumber', []);
  const n = Number(BigInt(r));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Direct USDC transfers involving `address`, newest first.
 *
 * Scans backwards from the head in `step`-sized windows. `lookback` bounds the
 * scan because the public node will not serve an unbounded history; raise it if
 * a send older than that is missing, at the cost of more requests.
 */
export async function fetchDirectTransfers(
  address: string,
  opts: { lookback?: number; step?: number } = {},
): Promise<DirectTransfer[]> {
  const lookback = opts.lookback ?? 30_000;
  const step = opts.step ?? 500;

  const head = await headBlock();
  if (!head) return [];

  const me = address.toLowerCase();
  const usdc = USDC.toLowerCase();
  const found = new Map<string, DirectTransfer>();

  for (let end = head; end > Math.max(0, head - lookback); end -= step) {
    const from = Math.max(0, end - step + 1);
    let logs: RpcLog[];
    try {
      logs = await rpc<RpcLog[]>('eth_getLogs', [
        { fromBlock: hex(from), toBlock: hex(end), address: USDC, topics: [TRANSFER_TOPIC] },
      ]);
    } catch {
      // Rate limited or the range refused. Keep what we have; a recent send is
      // more useful than a complete but stale list.
      break;
    }

    for (const l of logs) {
      // Keep only USDC's own log; the system emitter mirrors it.
      if (l.address.toLowerCase() !== usdc) continue;
      if (l.topics.length < 3) continue;

      const fromAddr = '0x' + l.topics[1].slice(-40);
      const toAddr = '0x' + l.topics[2].slice(-40);
      const isOut = fromAddr.toLowerCase() === me;
      const isIn = toAddr.toLowerCase() === me;
      if (!isOut && !isIn) continue;
      if (found.has(l.transactionHash)) continue;

      found.set(l.transactionHash, {
        hash: l.transactionHash,
        block: Number(BigInt(l.blockNumber)),
        outgoing: isOut,
        counterparty: isOut ? toAddr : fromAddr,
        amount: Number(BigInt(l.data)) / 1e6,
      });
    }
  }

  return [...found.values()].sort((a, b) => b.block - a.block);
}
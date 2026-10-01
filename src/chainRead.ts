import { createPublicClient, http } from 'viem';
import { arcTestnet } from './chain';
import { ESCROW } from './intent';

const client = createPublicClient({ chain: arcTestnet, transport: http() });

export const STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Cancelled'] as const;

export interface Job {
  id: bigint;
  client: string;
  provider: string;
  budget: bigint;
  expiresAt: bigint;
  description: string;
  status: number;
  deliverableHash: string;
}

const GET_JOB_SIG = 'getJob(uint256)';

/**
 * getJob returns a struct with a trailing dynamic string. The generic ABI
 * decoder mis-handles this nested offset layout, so decode the words directly:
 *   w0 offset-to-struct (32)
 *   w1 id | w2 client | w3 provider | w4 budget | w5 expiresAt
 *   w6 offset-to-description (relative to w7) | w7 status | w8 deliverableHash
 *   then the string: length word + bytes
 */
export function decodeJob(hex: `0x${string}`): Job {
  // NB: viem's hexToBytes mis-sizes even-length hex strings (returns 63 bytes
  // for 64), so convert by hand rather than trusting it.
  const h = hex.slice(2);
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  const word = (i: number): bigint => {
    let s = '';
    for (let k = i * 32; k < (i + 1) * 32; k++) s += b[k].toString(16).padStart(2, '0');
    return BigInt('0x' + s || '0');
  };
  const addr = (i: number): string => {
    let s = '';
    for (let k = i * 32 + 12; k < (i + 1) * 32; k++) s += b[k].toString(16).padStart(2, '0');
    return '0x' + s;
  };

  // description offset (w6) is in BYTES measured from the start of the tuple,
  // which begins at word 1 (w0 holds the top-level offset 0x20).
  const descStart = 1 + Number(word(6)) / 32;
  const descLen = Number(word(descStart));
  let description = '';
  for (let k = 0; k < descLen; k++) {
    description += String.fromCharCode(b[(descStart + 1) * 32 + k]);
  }

  return {
    id: word(1),
    client: addr(2),
    provider: addr(3),
    budget: word(4),
    expiresAt: word(5),
    description,
    status: Number(word(7)),
    deliverableHash: '0x' + Array.from(b.slice(8 * 32, 9 * 32)).map(x => x.toString(16).padStart(2, '0')).join(''),
  };
}

export async function readJob(jobId: bigint): Promise<Job> {
  // selector for getJob(uint256), verified with `cast sig`
  const data = ('0xbf22c457' + jobId.toString(16).padStart(64, '0')) as `0x${string}`;
  const raw = await client.request({ method: 'eth_call', params: [{ to: ESCROW, data }, 'latest'] });
  return decodeJob(raw as `0x${string}`);
}

/**
 * No totalJobs() getter exists — _nextJobId is private in the contract.
 * Probe getJob(1..) until it reverts with JobNotFound.
 */
export async function readAllJobs(max = 100): Promise<Job[]> {
  const out: Job[] = [];
  for (let i = 1n; i <= BigInt(max); i++) {
    try { out.push(await readJob(i)); }
    catch { break; }
  }
  return out;
}

export { GET_JOB_SIG };
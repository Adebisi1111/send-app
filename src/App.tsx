import { parseIntent, parseSplit, splitUnits, ParseError, type ParsedIntent, type SplitIntent } from './intent';
import { useState } from 'react';
import { useAccount, useConnect, useWriteContract } from 'wagmi';
import { createPublicClient, http, parseAbi } from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';
import { arcTestnet } from './chain';
import { USDC, ESCROW } from './intent';
import { readAllJobs, STATUS, type Job } from './chainRead';

const ESCROW_ABI = parseAbi([
  'function createJob(address provider, uint256 budget, uint256 expiresAt, string calldata description) returns (uint256 jobId)',
  'function fund(uint256 jobId)',
]);
const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const client = createPublicClient({ chain: arcTestnet, transport: http() });

export default function App() {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<ParsedIntent | null>(null);
  const [split, setSplit] = useState<SplitIntent | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { writeContractAsync } = useWriteContract();

  // The contract's job counter is private with no getter, so probe getJob(1..)
  // until it reverts with JobNotFound. Cheap on a testnet with a handful of jobs.
  async function loadJobs() {
    setBusy('Reading chain…');
    try { setJobs(await readAllJobs()); }
    catch (e) { console.error(e); }
    finally { setBusy(null); }
  }

  function handleParse() {
    setParseError(null); setTxHash(null); setSplit(null);
    try {
      if (/\bsplit\b/i.test(text.trim())) { setIntent(null); setSplit(parseSplit(text)); return; }
      setIntent(parseIntent(text));
    }
    catch (e) { setIntent(null); setParseError(e instanceof ParseError ? e.message : 'Could not parse that.'); }
  }

  /** Create one escrow job per share, funding each in turn. */
  async function handleConfirmSplit() {
    if (!split || !address) return;
    setBusy('Creating escrow jobs…');
    try {
      const totalUnits = BigInt(Math.round(split.totalUsdc * 10 ** 6));
      const parts = splitUnits(totalUnits, split.shares);
      const done: string[] = [];
      for (let i = 0; i < split.addresses.length; i++) {
        const budget = i === 0 ? parts[0] + (parts.length < split.shares ? 0n : 0n) : parts[i];
        const h = await writeContractAsync({
          address: ESCROW, abi: ESCROW_ABI, functionName: 'createJob',
          args: [split.addresses[i] as `0x${string}`, budget, BigInt(split.expiresAt),
                 `${split.description} (${i + 1}/${split.addresses.length})`],
        });
        await waitForTransactionReceipt(client, { hash: h });
        done.push(h);

        const app = await writeContractAsync({
          address: USDC.address, abi: ERC20_ABI, functionName: 'approve', args: [ESCROW, budget],
        });
        await waitForTransactionReceipt(client, { hash: app });

        const all = await readAllJobs();
        const jobId = all.length ? all[all.length - 1].id : 0n;
        const fh = await writeContractAsync({ address: ESCROW, abi: ESCROW_ABI, functionName: 'fund', args: [jobId] });
        await waitForTransactionReceipt(client, { hash: fh });
      }
      setTxHash(done[done.length - 1] ?? null);
      setBusy(null); setSplit(null); setText('');
      await loadJobs();
    } catch (e: any) {
      setBusy(null);
      setParseError('Split failed or was rejected: ' + (e?.shortMessage ?? e?.message ?? 'unknown'));
    }
  }

  async function handleConfirm() {
    if (!intent || !address) return;
    setBusy('Creating job…');
    try {
      const h = await writeContractAsync({
        address: ESCROW, abi: ESCROW_ABI, functionName: 'createJob',
        args: [intent.provider as `0x${string}`, intent.amountUnits, BigInt(intent.expiresAt), intent.description],
      });
      await waitForTransactionReceipt(client, { hash: h });
      setTxHash(h);

      setBusy('Approving USDC…');
      const app = await writeContractAsync({
        address: USDC.address, abi: ERC20_ABI, functionName: 'approve',
        args: [ESCROW, intent.amountUnits],
      });
      await waitForTransactionReceipt(client, { hash: app });

      // fund the job we just created — createJob's return value isn't
      // reliably surfaced through wagmi, so re-probe for the newest valid id.
      const all = await readAllJobs();
      const jobId = all.length ? all[all.length - 1].id : 0n;
      setBusy('Funding escrow…');
      const fh = await writeContractAsync({ address: ESCROW, abi: ESCROW_ABI, functionName: 'fund', args: [jobId] });
      await waitForTransactionReceipt(client, { hash: fh });

      setBusy(null); setIntent(null); setText('');
      await loadJobs();
    } catch (e: any) {
      setBusy(null);
      setParseError('Transaction failed or was rejected: ' + (e?.shortMessage ?? e?.message ?? 'unknown'));
    }
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui', maxWidth: 720, margin: '0 auto', padding: 32, color: '#e6e8ee', background: '#0b0e14', minHeight: '100vh' }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Arc Job Escrow</h1>
      <p style={{ color: '#9aa3b2', marginTop: 6 }}>Describe a payment or split in plain English. Nothing is signed until you confirm.</p>

      {!isConnected ? (
        <button onClick={() => connect({ connector: connectors[0] })}
          style={{ marginTop: 20, padding: '12px 18px', borderRadius: 8, border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer' }}>
          Connect wallet
        </button>
      ) : (
        <p style={{ marginTop: 12, color: '#6ee7b7', fontSize: 14 }}>Connected: {address}</p>
      )}

      <div style={{ marginTop: 24 }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="split 100 USDC between 0xA08a79B4f6e5a7322E0df73Ab514006Dd3710B9D and 0x47D19387fB2D71A3107e4E8748E533AF944E84B4 for the dinner"
          rows={3}
          style={{ width: '100%', padding: 14, borderRadius: 10, background: '#151923', border: '1px solid #262d3a', color: '#e6e8ee', fontSize: 15, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <button onClick={handleParse} disabled={!text.trim()}
          style={{ marginTop: 12, padding: '11px 18px', borderRadius: 8, border: 'none', background: text.trim() ? '#3b82f6' : '#2a3140', color: '#fff', cursor: text.trim() ? 'pointer' : 'not-allowed' }}>
          Preview terms
        </button>
      </div>

      {parseError && (
        <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: '#2a1518', border: '1px solid #5c2530', color: '#fca5a5', fontSize: 14 }}>
          {parseError}
        </div>
      )}

      {split && (
        <div style={{ marginTop: 20, padding: 20, borderRadius: 12, background: '#121721', border: '1px solid #2b3444' }}>
          <h2 style={{ margin: '0 0 14px', fontSize: 13, color: '#9aa3b2', textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Confirm split — {split.addresses.length} escrow jobs
          </h2>
          <div style={{ fontSize: 14, marginBottom: 12, color: '#c8ccd6' }}>
            Splitting <strong>{split.totalUsdc} USDC</strong> {split.shares === split.addresses.length
              ? `between ${split.addresses.length} people`
              : `${split.addresses.length} ways`}.
          </div>
          {split.addresses.map((a, i) => {
            const parts = splitUnits(BigInt(Math.round(split.totalUsdc * 10 ** 6)), split.shares);
            const units = i < parts.length ? parts[i] : parts[parts.length - 1];
            return (
              <div key={a} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid #1e2430', fontSize: 13 }}>
                <span style={{ color: '#9aa3b2', flexShrink: 0 }}>{i + 1}. {a.slice(0, 10)}…</span>
                <span style={{ fontFamily: 'ui-monospace, monospace' }}>{Number(units) / 1e6} USDC</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button onClick={handleConfirmSplit} disabled={!isConnected || !!busy}
              style={{ flex: 1, padding: '12px', borderRadius: 8, border: 'none', background: isConnected && !busy ? '#10b981' : '#2a3140', color: '#04231a', fontWeight: 600, cursor: isConnected && !busy ? 'pointer' : 'not-allowed' }}>
              {busy ?? `Fund ${split.addresses.length} escrow job${split.addresses.length > 1 ? 's' : ''}`}
            </button>
            <button onClick={() => setSplit(null)}
              style={{ padding: '12px 20px', borderRadius: 8, border: '1px solid #2b3444', background: 'transparent', color: '#9aa3b2', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 12, color: '#6b7488' }}>
            Each share goes into its own escrow job, so every recipient is paid independently on delivery.
          </p>
        </div>
      )}

      {intent && (
        <div style={{ marginTop: 20, padding: 20, borderRadius: 12, background: '#121721', border: '1px solid #2b3444' }}>
          <h2 style={{ margin: '0 0 14px', fontSize: 13, color: '#9aa3b2', textTransform: 'uppercase', letterSpacing: 0.6 }}>Confirm before signing</h2>
          {([
            ['Provider', intent.provider],
            ['Amount', `${intent.amountUsdc} USDC`],
            ['Deliverable', intent.description],
            ['Expires', intent.expiryLabel],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 20, padding: '9px 0', borderBottom: '1px solid #1e2430', fontSize: 14 }}>
              <span style={{ color: '#9aa3b2', flexShrink: 0 }}>{k}</span>
              <span style={{ fontFamily: 'ui-monospace, monospace', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button onClick={handleConfirm} disabled={!isConnected || !!busy}
              style={{ flex: 1, padding: '12px', borderRadius: 8, border: 'none', background: isConnected && !busy ? '#10b981' : '#2a3140', color: '#04231a', fontWeight: 600, cursor: isConnected && !busy ? 'pointer' : 'not-allowed' }}>
              {busy ?? 'Confirm & create escrow'}
            </button>
            <button onClick={() => setIntent(null)}
              style={{ padding: '12px 20px', borderRadius: 8, border: '1px solid #2b3444', background: 'transparent', color: '#9aa3b2', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 12, color: '#6b7488' }}>
            Creates the job, approves USDC, and funds escrow. USDC is only released when you complete the job after delivery.
          </p>
        </div>
      )}

      {txHash && (
        <p style={{ marginTop: 16, fontSize: 13, color: '#6ee7b7' }}>
          Submitted: <a style={{ color: '#3b82f6' }} href={`https://explorer.testnet.arc.io/tx/${txHash}`} target="_blank" rel="noreferrer">{txHash.slice(0, 14)}…</a>
        </p>
      )}

      <div style={{ marginTop: 40 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Jobs on chain</h2>
          <button onClick={loadJobs} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #2b3444', background: 'transparent', color: '#9aa3b2', cursor: 'pointer', fontSize: 13 }}>Refresh</button>
        </div>
        {jobs.length === 0 && <p style={{ color: '#6b7488', fontSize: 14 }}>No jobs read yet — press Refresh.</p>}
        {jobs.map(j => (
          <div key={j.id.toString()} style={{ marginTop: 12, padding: 14, borderRadius: 10, background: '#121721', border: '1px solid #1e2430' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>Job #{j.id.toString()}</strong>
              <span style={{
                fontSize: 12, padding: '3px 9px', borderRadius: 20,
                background: j.status === 3 ? '#064e3b' : j.status === 4 ? '#4c1d24' : j.status === 1 ? '#1e3a5f' : '#2a3140',
                color: j.status === 3 ? '#6ee7b7' : j.status === 4 ? '#fca5a5' : '#9aa3b2',
              }}>{STATUS[j.status] ?? j.status}</span>
            </div>
            <div style={{ fontSize: 12, color: '#9aa3b2', fontFamily: 'ui-monospace, monospace' }}>
              {Number(j.budget) / 1e6} USDC → {j.provider.slice(0, 10)}…
            </div>
            {j.description && <div style={{ marginTop: 6, fontSize: 13, color: '#c8ccd6' }}>{j.description}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
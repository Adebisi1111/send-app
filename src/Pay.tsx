import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useConnect, useSwitchChain, useWriteContract } from 'wagmi';
import { createPublicClient, http, zeroAddress } from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';
import { arc } from './chain';
import {
  USDC, REGISTRY, REQUESTS, REGISTRY_ABI, REQUEST_ABI, ERC20_ABI,
  STATUS, fmtUsdc, short, DAY,
  isOpen, isOpenRequest, remaining, mergeActionable, directionOf, explain, sameAddress,
  RPC_URL,
  type Request,
} from './pay';
import { fetchDirectTransfers, type DirectTransfer } from './transfers';

const client = createPublicClient({ chain: arc, transport: http(RPC_URL) });

// keccak256("getRequest(uint256)")[:4]
const GET_REQUEST = '0xc58343ef';

// ---------------------------------------------------------------- helpers

/** Status badge class: 1 = Open, 2 = Paid. */
const badgeClass = (s: number): string =>
  s === 1 ? 'badge badge-open' : s === 2 ? 'badge badge-paid' : 'badge badge-gone';

async function resolveName(u: string): Promise<`0x${string}`> {
  const who = await client.readContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'resolve', args: [u],
  });
  return who as unknown as `0x${string}`;
}

/**
 * Read a request. Decoded from raw words rather than through viem's struct
 * decoder, which mis-reads this struct's string offsets.
 */
async function readRequest(id: bigint): Promise<Request | null> {
  try {
    const raw = (await client.request({
      method: 'eth_call',
      params: [{
        to: REQUESTS,
        data: (GET_REQUEST + id.toString(16).padStart(64, '0')) as `0x${string}`,
      }, 'latest'],
    })) as `0x${string}`;
    const h = raw.slice(2);
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    const word = (i: number): bigint => {
      let s = '';
      for (let k = i * 32; k < (i + 1) * 32; k++) s += b[k].toString(16).padStart(2, '0');
      return BigInt('0x' + s || '0');
    };
    // The return value is a dynamic struct: word 0 holds the offset to its body,
    // so every field index is shifted by one when read from the raw words.
    const base = Number(word(0));
    const field = (i: number): bigint => word(i + 1);
    const str = (i: number): string => {
      const at = base + Number(field(i));
      let len = 0;
      for (let k = 0; k < 32; k++) len = len * 256 + b[at + k];
      let out = '';
      for (let k = at + 32; k < at + 32 + len; k++) out += String.fromCharCode(b[k]);
      return out;
    };
    const hex = (i: number): `0x${string}` =>
      ('0x' + field(i).toString(16).padStart(40, '0')) as `0x${string}`;
    return {
      id: field(0),
      requester: hex(1),
      named: hex(2),
      username: str(3),
      purpose: str(4),
      amount: field(5),
      collected: field(6),
      expiresAt: field(7),
      status: Number(field(8)),
    };
  } catch {
    return null;
  }
}

async function loadMany(ids: bigint[]): Promise<Request[]> {
  const rs = await Promise.all(ids.map(readRequest));
  return rs.filter((r): r is Request => !!r);
}

// ---------------------------------------------------------------- app

/**
 * How long a confirmed action stays on screen. Long enough to read a hash-free
 * summary, short enough that it never looks like something still pending.
 */
const NOTE_MS = 6000;

export default function Pay() {
  const { address } = useAccount();
  // wagmi can report isConnected before accounts resolve, which would skip
  // every read. Treat connected as "has an address".
  const isConnected = !!address;
  const { connect, connectors } = useConnect();
  const { writeContractAsync } = useWriteContract();

  const [tab, setTab] = useState<'send' | 'ask' | 'topay' | 'mine'>('send');

  const [balance, setBalance] = useState<bigint | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  const [step, setStep] = useState<'welcome' | 'claim' | 'ready'>('claim');

  // asking
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');

  // direct send, separate from asking so the two forms never share a field
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendNote, setSendNote] = useState('');
  const [sendPreview, setSendPreview] = useState<`0x${string}` | null | 'unknown'>(null);
  const [purpose, setPurpose] = useState('');

  // paying

  // username
  const [name, setName] = useState('');
  const [nameState, setNameState] = useState<{ taken?: boolean; done?: boolean }>({});

  const [toPay, setToPay] = useState<Request[]>([]);
  const [openFeed, setOpenFeed] = useState<Request[]>([]);
  /** Everything the connected account has touched, in either direction. */
  const [history, setHistory] = useState<Request[]>([]);
  const [direct, setDirect] = useState<DirectTransfer[]>([]);
  /**
   * Requests the account can act on, in one list: addressed to them by name,
   * plus open requests anyone can settle. Two tabs for one job was the
   * confusion, so it is one tab now.
   */
  const actionable = useMemo(
    () =>
      mergeActionable(toPay, openFeed).filter(
        (r) => directionOf(r, address ?? zeroAddress) === 'asked-of-me',
      ),
    [toPay, openFeed, address],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [contractMissing, setContractMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Seconds left before the success line clears itself. */
  const [noteLeft, setNoteLeft] = useState(0);
  const noteTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [alert, setAlert] = useState<{ title: string; body: string } | null>(null);
  const [wantNotify, setWantNotify] = useState(
    () => typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default',
  );

  // chain handling
  const wagmiChainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [walletChain, setWalletChain] = useState<number | null>(null);

  const readChain = useCallback(async () => {
    const w = window as Window & { ethereum?: { request: (a: unknown) => Promise<unknown> } };
    if (!w.ethereum?.request) return;
    try {
      setWalletChain(Number((await w.ethereum.request({ method: 'eth_chainId' })) as string));
    } catch {
      /* wallet refused; keep wagmi's view */
    }
  }, []);

  useEffect(() => {
    if (!isConnected) { setWalletChain(null); return; }
    void readChain();
    const w = window as Window & {
      ethereum?: {
        on?: (e: string, f: () => void) => void;
        removeListener?: (e: string, f: () => void) => void;
      };
    };
    // stable refs: removeListener compares identity
    const onChain = () => void readChain();
    w.ethereum?.on?.('chainChanged', onChain);
    w.ethereum?.on?.('accountsChanged', onChain);
    return () => {
      w.ethereum?.removeListener?.('chainChanged', onChain);
      w.ethereum?.removeListener?.('accountsChanged', onChain);
    };
  }, [isConnected, readChain]);

  const chainId = walletChain ?? wagmiChainId;
  const wrongChain = isConnected && chainId !== arc.id;

  /**
   * A wallet reaches Arc over whichever RPC *it* has configured for chain 5042,
   * which is not necessarily the one this app reads over. A stale or unreachable
   * endpoint there fails every write while reads keep working, which looks like
   * the app is offline. Ask the wallet what it has and correct it if we can.
   */
  const repairWalletRpc = async () => {
    const w = window as Window & {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    };
    if (!w.ethereum) return;
    try {
      const res = (await w.ethereum.request({
        method: 'wallet_getAllRpcUrls',
        params: [{ chainId: '0x13b2' }],
      })) as { rpcUrls?: { http: string[] }[] } | undefined;
      const http = res?.rpcUrls?.[0]?.http ?? [];
      if (!http.length) return;
      const live = http.filter((u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } });
      if (live.length === 1 && live[0] === RPC_URL) return;
      // Rewrite the wallet's Arc endpoint to the one this app is verified
      // against. Not every wallet exposes this; failures are ignored.
      await w.ethereum.request({
        method: 'wallet_updateEthereumChain',
        params: [{
          chainId: '0x13b2',
          rpcUrls: [RPC_URL, ...live.filter((u) => u !== RPC_URL)],
        }],
      });
    } catch {
      /* wallet does not support these methods - nothing to repair */
    }
  };

  const switchToArc = async () => {
    const w = window as Window & { ethereum?: { request: (a: unknown) => Promise<unknown> } };
    await repairWalletRpc();
    try {
      await w.ethereum?.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x13b2' }],
      });
    } catch (e: unknown) {
      if ((e as { code?: number })?.code === 4902 && w.ethereum?.request) {
        await w.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x13b2',
            chainName: 'Arc',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            rpcUrls: ['https://rpc.mainnet.arc.io'],
            blockExplorerUrls: ['https://explorer.arc.io'],
          }],
        }).catch(() => { /* declined */ });
      }
    }
    await readChain();
    void switchChain({ chainId: arc.id });
  };

  /** Balance and username. Safe to call after anything that moves money. */
  const refresh = async () => {
    if (!address) return;
    // A wrong or undeployed address returns empty data, which otherwise fails
    // silently and leaves the UI stuck. Fail loudly instead.
    try {
      const code = await client.getCode({ address: REQUESTS });
      if (!code || code === '0x') setContractMissing(true);
    } catch {
      setContractMissing(true);
    }
    try {
      const [bal, who] = await Promise.all([
        client.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
        client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'usernameOf', args: [address] }),
      ]);
      setBalance(bal);
      const u = (who as unknown as string) ?? '';
      setMyName(u.length ? u : null);
    } catch {
      setBalance(null);
    }
  };

  useEffect(() => {
    if (!address) return;
    (async () => {
      await refresh();
      try {
        const who = (await client.readContract({
          address: REGISTRY, abi: REGISTRY_ABI, functionName: 'usernameOf', args: [address],
        })) as unknown as string;
        // An empty username decodes as '', but a missing one can surface as null.
        // Anything that is not a non-empty string means "needs a username".
        setStep(typeof who === 'string' && who.length > 0 ? 'ready' : 'welcome');
      } catch {
        setStep('welcome');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const loadAll = useCallback(async () => {
    if (!address) return;
    try {
      const [asked, opened, feed] = await Promise.all([
        client.readContract({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'askedOf', args: [address] }),
        client.readContract({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'openedBy', args: [address] }),
        client.readContract({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'openRequests', args: [100n] }),
      ]);
      const [tp, mn, op] = await Promise.all([
        loadMany(asked as unknown as bigint[]),
        loadMany(opened as unknown as bigint[]),
        loadMany(feed as unknown as bigint[]),
      ]);
      // Requests you can act on first, then newest first within each group.
      const byNeed = (a: Request, b: Request) => {
        const ao = isOpen(a) ? 0 : 1;
        const bo = isOpen(b) ? 0 : 1;
        return ao !== bo ? ao - bo : Number(b.id - a.id);
      };
      setToPay(tp.filter(isOpen).sort(byNeed));
      setOpenFeed(op.filter(isOpen).sort(byNeed));
      // One list for the whole account: everything asked of me, everything I
      // asked, and anything I have already paid, newest first.
      const seen = new Set<string>();
      const all: Request[] = [];
      for (const r of [...tp, ...mn, ...op]) {
        const k = r.id.toString();
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(r);
      }
      setHistory(all.sort((a, b) => Number(b.id - a.id)));
    } catch {
      /* transient RPC failure — retried on the next tick */
    }

    // A direct Send is a plain ERC-20 transfer, so it has no request id and the
    // contract views above cannot see it. Without this, sending someone USDC
    // left no trace in History at all.
    try {
      setDirect(await fetchDirectTransfers(address));
    } catch {
      /* rate limited or the node refused the range; requests still show */
    }
  }, [address]);

  const seen = useRef<Set<string>>(new Set());

  // Watch for settlements so a request surfaces without a manual refresh.
  const poll = useCallback(async () => {
    if (!address) return;
    await loadAll();
    if (!seen.current.size) return;
    try {
      const asked = (await client.readContract({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'askedOf', args: [address],
      })) as unknown as bigint[];
      for (const id of asked) {
        const key = id.toString();
        const r = await readRequest(id);
        if (!r || !isOpen(r) || seen.current.has(key)) continue;
        const left = remaining(r);
        if (left === 0n) continue;
        seen.current.add(key);
        const got = r.amount - r.collected;
        const msg = `${fmtUsdc(got)} USDC still owed to you${r.username ? ` by @${r.username}` : ''}`;
        setAlert({ title: 'Still waiting', body: msg });
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(msg, { tag: `send-${id}` });
        }
      }
    } catch {
      /* ignore */
    }
  }, [address, loadAll]);

  useEffect(() => {
    if (step !== 'ready') return;
    void poll().then(() => { seen.current.clear(); });
    const t = setInterval(() => { if (document.visibilityState === 'visible') void poll(); }, 12_000);
    const onVis = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [step, poll]);

  // A shared request link opens the To Pay tab.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('r');
    if (id) {
      setTab('topay');
      const btn = document.querySelector('[data-req="' + id + '"]') as HTMLElement | null;
      btn?.scrollIntoView({ block: 'center' });
    }
  }, []);

  /**
   * Show a success line, then clear it. It used to persist until the next
   * action, which meant a confirmed transfer sat on screen indefinitely and
   * could be mistaken for something still in flight. The countdown is visible
   * so it never disappears without warning, and hovering holds it open.
   */
  const flash = (text: string, ms: number) => {
    if (noteTimer.current) clearInterval(noteTimer.current);
    setNote(text);
    setNoteLeft(Math.ceil(ms / 1000));
    noteTimer.current = setInterval(() => {
      setNoteLeft((s) => {
        if (s <= 1) {
          if (noteTimer.current) clearInterval(noteTimer.current);
          noteTimer.current = null;
          setNote(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  const clearFlash = () => {
    if (noteTimer.current) clearInterval(noteTimer.current);
    noteTimer.current = null;
    setNote(null);
    setNoteLeft(0);
  };

  // A success line left running when the tab goes away would fire into an
  // unmounted tree, so stop it on unmount.
  useEffect(() => () => { if (noteTimer.current) clearInterval(noteTimer.current); }, []);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label); setErr(null); clearFlash();
    try {
      flash(await fn(), NOTE_MS);
      await Promise.all([refresh(), loadAll()]);
      return true;
    } catch (e: unknown) {
      setErr(explain(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const claim = () =>
    run('Claiming…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const taken = await client.readContract({
        address: REGISTRY, abi: REGISTRY_ABI, functionName: 'isTaken', args: [name.toLowerCase()],
      });
      if (taken) { setNameState({ taken: true }); throw new Error(`@${name} is already taken`); }
      const h = await writeContractAsync({
        address: REGISTRY, abi: REGISTRY_ABI, functionName: 'register', args: [name.toLowerCase()],
      });
      await waitForTransactionReceipt(client, { hash: h });
      setNameState({ done: true });
      setMyName(name.toLowerCase());
      setStep('ready');
      return `You are now @${name.toLowerCase()}`;
    });

  const ask = () =>
    run('Posting…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const units = BigInt(Math.round(parseFloat(amount) * 1e6));
      if (!Number.isFinite(parseFloat(amount)) || units <= 0n) throw new Error('Enter an amount');
      if (!purpose.trim()) throw new Error('Say what it is for');

      const expiry = BigInt(Math.floor(Date.now() / 1000) + 14 * DAY);
      let h: `0x${string}`;
      let target = '';

      // Always ask someone by name. Open requests stay supported on chain, but
      // the app only creates named ones: a request you can decline needs a
      // person to decline it.
      const handle = to.replace(/^@/, '').toLowerCase();
      if (!handle) throw new Error('Who are you asking? Enter their username');
      const who = await resolveName(handle);
      if (!who || who === zeroAddress) throw new Error(`No one is @${handle}`);
      h = await writeContractAsync({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'ask',
        args: [handle, purpose.trim(), units, expiry],
      });
      target = `@${handle}`;

      await waitForTransactionReceipt(client, { hash: h });
      const link = `${location.origin}/?r=${h}`;
      try {
        await navigator.clipboard.writeText(link);
        return `Asked ${target} for ${amount} USDC — link copied, send it to anyone`;
      } catch {
        return `Asked ${target} for ${amount} USDC`;
      }
    });

  /** Settle a request in full. Part payments are supported by the contract
   *  but not offered; see the note where the control used to sit. */
  const settle = (r: Request) =>
    run('Paying…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const amt = remaining(r);
      if (amt <= 0n) throw new Error('Nothing left to pay');

      const approve = await writeContractAsync({
        address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [REQUESTS, amt],
      });
      await waitForTransactionReceipt(client, { hash: approve });

      const h = await writeContractAsync({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'pay', args: [r.id, amt],
      });
      await waitForTransactionReceipt(client, { hash: h });
      const done = r.collected + amt === r.amount;
      return done
        ? `Paid ${fmtUsdc(amt)} USDC — request fully settled`
        : `Paid ${fmtUsdc(amt)} USDC — ${fmtUsdc(r.amount - r.collected - amt)} still to go`;
    });

  // Resolve the recipient while typing so a mistyped name is caught before
  // any USDC leaves the wallet.
  useEffect(() => {
    const handle = sendTo.replace(/^@/, '').trim().toLowerCase();
    if (!handle) { setSendPreview(null); return; }
    let live = true;
    (async () => {
      try {
        const who = await resolveName(handle);
        if (live) setSendPreview(who && who !== zeroAddress ? who : 'unknown');
      } catch {
        if (live) setSendPreview('unknown');
      }
    })();
    return () => { live = false; };
  }, [sendTo]);

  const send = () =>
    run('Sending…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const handle = sendTo.replace(/^@/, '').trim().toLowerCase();
      if (!handle) throw new Error('Who are you sending to?');
      const who = await resolveName(handle);
      if (!who || who === zeroAddress) throw new Error(`No one is @${handle}`);
      if (who === address) throw new Error('That is your own username');

      const units = BigInt(Math.round(parseFloat(sendAmount) * 1e6));
      if (!Number.isFinite(parseFloat(sendAmount)) || units <= 0n) throw new Error('Enter an amount');
      if (balance !== null && units > balance) throw new Error('More than your balance');

      const h = await writeContractAsync({
        address: USDC, abi: ERC20_ABI, functionName: 'transfer', args: [who, units],
      });
      await waitForTransactionReceipt(client, { hash: h });
      setSendAmount('');
      setSendNote('');
      return `Sent ${fmtUsdc(units)} USDC to @${handle}`;
    });

  const refuse = (r: Request) =>
    run('Declining…', async () => {
      const h = await writeContractAsync({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'decline', args: [r.id],
      });
      await waitForTransactionReceipt(client, { hash: h });
      return `Declined request #${r.id} — nothing was sent`;
    });

  const cancelRequest = (r: Request) =>
    run('Closing…', async () => {
      const h = await writeContractAsync({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'cancel', args: [r.id],
      });
      await waitForTransactionReceipt(client, { hash: h });
      return `Closed request #${r.id}`;
    });

  const closePartial = (r: Request) =>
    run('Closing…', async () => {
      const h = await writeContractAsync({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'close', args: [r.id],
      });
      await waitForTransactionReceipt(client, { hash: h });
      return `Closed #${r.id} — you kept the ${fmtUsdc(r.collected)} USDC already paid`;
    });

  // ------------------------------------------------------------ onboarding

  if (!isConnected) {
    return (
      <div className="connect">
        <div className="card connect-card">
          <div className="mark">S</div>
          <h1>Send USDC by name</h1>
          <p>
            Send USDC to anyone by username, or ask someone for USDC and let them pay
            you. Nothing is held in escrow, so nothing can get stuck.
          </p>
          {connectors.map((c) => (
            <button key={c.id} onClick={() => connect({ connector: c })} className="btn btn-lg btn-full">
              Connect {c.id === 'injected' ? 'browser wallet' : c.name}
            </button>
          ))}
          <div className="connect-note">
            <div className="net-row">
              <span className="pill"><span className="dot" />Arc mainnet · chain {arc.id}</span>
            </div>
            <p className="net-copy">
              USDC is the gas token on Arc, so sending costs nothing in the network fee.
            </p>
            <p className="net-copy">
              Non-custodial throughout: the payer sends their own USDC straight to you.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (step !== 'ready') {
    const suggestions = ['zara', 'kwame', 'ngozi', 'ife', 'tunde', 'bola'];
    return (
      <div className="shell">
        <header className="top">
          <div className="brand">
            <div className="mark">S</div>
            <span className="brand-name">Send</span>
          </div>
          <div className={`pill${wrongChain ? ' pill-bad' : ''}`}>
            <span className="dot" />{wrongChain ? `Chain ${chainId}` : 'Arc mainnet'}
          </div>
        </header>

        {wrongChain && (
          <div className="net-warn" role="alert">
            <div>
              <div className="net-t">Wrong network</div>
              <div className="net-m">You are on chain {chainId}. This app needs Arc ({arc.id}).</div>
            </div>
            <button className="btn btn-sm" disabled={switching} onClick={switchToArc}>
              {switching ? 'Switching…' : 'Switch to Arc'}
            </button>
          </div>
        )}

        <div className="steps">
          <div className="step step-done"><span className="step-n">✓</span><span>Connect wallet</span></div>
          <div className={`step${step === 'claim' ? ' step-now' : ''}`}>
            <span className="step-n">{step === 'claim' ? '2' : '3'}</span><span>Claim a username</span>
          </div>
          <div className="step"><span className="step-n">3</span><span>Send, ask or settle</span></div>
        </div>

        {balance !== null && (
          <div className="card bal-card">
            <div>
              <div className="bal-amt big">{fmtUsdc(balance)} <span className="bal-unit">USDC</span></div>
              <div className="hint" style={{ marginTop: 4 }}>{short(address!)}</div>
            </div>
          </div>
        )}

        {err && <div className="msg msg-err">{err}</div>}
        {note && (
          <div className="msg msg-ok" onMouseEnter={() => clearFlash()}>
            <span className="msg-txt">{note}</span>
            <button className="msg-x" onClick={clearFlash} aria-label="Dismiss">
              {noteLeft}s ✕
            </button>
          </div>
        )}

        {step === 'welcome' && (
          <div className="card">
            <h2 className="card-h">How it works</h2>
            <p className="card-p">
              Send USDC to anyone by username. Or ask someone for USDC and let them pay
              you — either way the money goes straight between wallets.
            </p>
            <ul className="feat">
              <li>Send to anyone by username, no address needed</li>
              <li>Ask someone for USDC against a stated purpose</li>
              <li>They accept or decline — your choice either way</li>
              <li>Nothing is escrowed, so nothing can get stuck</li>
            </ul>
            <button className="btn btn-lg btn-full" onClick={() => setStep('claim')}>
              Pick a username →
            </button>
          </div>
        )}

        {step === 'claim' && (
          <div className="card">
            <h2 className="card-h">Claim your username</h2>
            <p className="card-p">This is how people will ask you for USDC. It is permanent.</p>
            <div className="row">
              <input className="field" id="claim-name" placeholder="yourname" value={name} maxLength={20}
                onChange={(e) => { setName(e.target.value.replace(/[^a-zA-Z0-9_]/g, '')); setNameState({}); }} />
              <button onClick={claim} disabled={!!busy || !name} className="btn">
                {busy ?? (nameState.done ? 'Claimed' : 'Claim')}
              </button>
            </div>
            {nameState.taken && <div className="err-text">That name is taken.</div>}
            <div className="label label-sp">Or try one of these</div>
            <div className="chips">
              {suggestions.map((s) => (
                <button key={s} className={`chip${name === s ? ' chip-on' : ''}`}
                  onClick={() => { setName(s); setNameState({}); }}>@{s}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------ main app

  /** A plain Send, which the contract cannot record because there is no request. */
  const renderDirect = (t: DirectTransfer) => (
    <div key={t.hash} className="card">
      <div className="req-head">
        <span className="req-amt">{fmtUsdc(BigInt(Math.round(t.amount * 1e6)))} USDC</span>
        <span className="badge badge-gone">{t.outgoing ? 'Sent' : 'Received'}</span>
      </div>
      <div className="req-why">{t.outgoing ? 'Direct send' : 'Received directly'}</div>
      <div className="req-from">
        {t.outgoing ? <>sent to {short(t.counterparty)}</> : <>received from {short(t.counterparty)}</>}
      </div>
      <div className="req-note">
        Straight USDC transfer{t.outgoing ? ' from your wallet' : ' into your wallet'} — no request involved.{' '}
        <a href={`https://arc.etherscan.io/tx/${t.hash}`} target="_blank" rel="noreferrer">view</a>
      </div>
    </div>
  );

  const renderRequest = (r: Request, mode: 'pay' | 'mine' | 'history') => {
    const left = remaining(r);
    const open = isOpen(r);
    const isOpenToAll = isOpenRequest(r);
    return (
      <div key={r.id.toString()} className="card" data-req={r.id.toString()}>
        <div className="req-head">
          <span className="req-amt">{fmtUsdc(r.amount)} USDC</span>
          <span className={badgeClass(r.status)}>{STATUS[r.status]}</span>
        </div>
        <div className="req-why">{r.purpose}</div>
        <div className="req-from">
          {directionOf(r, address ?? zeroAddress) === 'asking'
            ? <>asked of {isOpenRequest(r) ? 'anyone' : `@${r.username || short(r.named)}`}</>
            : <>asked of you by @{r.username || short(r.requester)}</>}
        </div>

        {open && left !== r.amount && (
          <div className="req-progress">
            <div className="bar"><div className="bar-fill" style={{ width: `${(Number(r.collected) / Number(r.amount)) * 100}%` }} /></div>
            <span>{fmtUsdc(r.collected)} of {fmtUsdc(r.amount)} paid</span>
          </div>
        )}

        {isOpenToAll && open && (
          <div className="req-note">
            Open request — anyone with the link can settle it.
          </div>
        )}

        {mode === 'pay' && open && (
          <>
            <div className="req-note">
              Leaves your wallet and goes straight to {sameAddress(r.requester, address) ? 'you' : 'the asker'}.
              {left !== r.amount && ` ${fmtUsdc(left)} USDC still needed.`}
            </div>
            {!sameAddress(r.requester, address) && (
              <>
                <div className="req-actions">
                  <button onClick={() => settle(r)} disabled={!!busy} className="btn">
                    {busy ?? `Pay ${fmtUsdc(left)} USDC`}
                  </button>
                  {sameAddress(r.named, address) && (
                    <button onClick={() => refuse(r)} disabled={!!busy} className="btn btn-ghost">
                      Decline
                    </button>
                  )}
                </div>
                {/* Part payments stay supported on chain but are not offered:
                    the flow is one person accepting one amount. Restore by
                    un-commenting; pay(id, amount) and close() already handle a
                    partly collected request. */}
              </>
            )}
            {sameAddress(r.requester, address) && (
              <div className="req-note">This is your own request. Waiting for {left === r.amount ? 'someone to pay' : `${fmtUsdc(left)} USDC more`}.</div>
            )}
          </>
        )}

        {mode === 'mine' && open && (
          <>
            <div className="req-note">
              {r.collected === 0n
                ? 'Nobody has paid yet. You can close it any time.'
                : `${fmtUsdc(r.collected)} USDC already paid to you. Close it and keep that.`}
            </div>
            <div className="req-actions">
              <button onClick={() => (r.collected === 0n ? cancelRequest(r) : closePartial(r))}
                disabled={!!busy} className="btn btn-warn">
                {busy ?? (r.collected === 0n ? 'Close request' : 'Close & keep it')}
              </button>
            </div>
          </>
        )}

        {!open && (
          <div className="req-done">
            {r.status === 2
              ? `Settled — ${fmtUsdc(r.amount)} USDC paid.`
              : 'Closed without payment.'}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <div className="mark">S</div>
          <span className="brand-name">Send</span>
        </div>
        <div className="acct">
          <div className="bal">
            <span className="bal-amt">{balance === null ? '—' : fmtUsdc(balance)}</span>
            <span className="bal-unit">USDC</span>
          </div>
          <div className="wallet">{myName ? `@${myName}` : short(address!)}</div>
        </div>
      </header>

      {wrongChain && (
        <div className="net-warn" role="alert">
          <div>
            <div className="net-t">Wrong network</div>
            <div className="net-m">You are on chain {chainId}. This app needs Arc ({arc.id}).</div>
          </div>
          <button className="btn btn-sm" disabled={switching} onClick={switchToArc}>
            {switching ? 'Switching…' : 'Switch to Arc'}
          </button>
        </div>
      )}

      {contractMissing && (
        <div className="net-warn" role="alert">
          <div>
            <div className="net-t">Contracts not found</div>
            <div className="net-m">
              Nothing is deployed at {short(REQUESTS)} on this chain. Point the app at a
              live deployment with VITE_REQUESTS and the other addresses.
            </div>
          </div>
        </div>
      )}

      {wantNotify && (
        <div className="card notify-card">
          <div>
            <div className="card-h sm">Get notified</div>
            <p className="card-p sm">Allow notifications so a payment reaches you without opening this app.</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={async () => {
            await Notification.requestPermission();
            setWantNotify(false);
          }}>Allow</button>
        </div>
      )}

      {alert && (
        <div className="toast" role="status">
          <div className="toast-bell">🔔</div>
          <div className="toast-body">
            <div className="toast-t">{alert.title}</div>
            <div className="toast-m">{alert.body}</div>
          </div>
          <button className="toast-x" onClick={() => setAlert(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="tabs" role="tablist">
        {([
          ['send', 'Send'],
          ['ask', 'Request'],
          ['topay', 'Pending'],
          ['mine', 'History'],
        ] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' tab-on' : ''}`}
            onClick={() => setTab(k)}>
            {l}
            {k === 'topay' && actionable.length > 0 && <span className="badge-n">{actionable.length}</span>}
          </button>
        ))}
      </div>

      {err && <div className="msg msg-err">{err}</div>}
      {note && (
        <div className="msg msg-ok" onMouseEnter={() => clearFlash()}>
          <span className="msg-txt">{note}</span>
          <button className="msg-x" onClick={clearFlash} aria-label="Dismiss">
            {noteLeft}s ✕
          </button>
        </div>
      )}

      {tab === 'send' && (
        <div className="card">
          <label className="label" htmlFor="send-to">Send USDC to a username</label>
          <input id="send-to" className="field" placeholder="username, e.g. kwame" autoComplete="off"
            value={sendTo} onChange={(e) => setSendTo(e.target.value)} />

          {sendPreview !== null && (
            <div className={`lookup${sendPreview === 'unknown' ? ' lookup-bad' : ''}`}>
              {sendPreview === 'unknown'
                ? `Nobody is @${sendTo.replace(/^@/, '').trim().toLowerCase()} — check the spelling`
                : <>sending to {sendPreview === address ? 'you' : short(sendPreview)}</>}
            </div>
          )}

          <input id="send-amt" className="field" placeholder="amount (USDC)" inputMode="decimal"
            value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />
          <input id="send-note" className="field" placeholder="note (optional)" maxLength={140}
            value={sendNote} onChange={(e) => setSendNote(e.target.value)} />

          <button onClick={send} disabled={!!busy || sendPreview === 'unknown' || sendPreview === null}
            className="btn btn-lg btn-full" style={{ marginTop: 14 }}>
            {busy ?? 'Send'}
          </button>
          <p className="hint">
            Goes straight from your wallet to theirs. No request, no contract in between,
            and the network fee is paid in USDC.
            {sendNote.trim() && ' The note is only for your own records — it is not stored on chain.'}
          </p>
        </div>
      )}

      {tab === 'ask' && (
        <div className="card">
          <label className="label" htmlFor="ask-to">Ask someone for USDC</label>
          <input id="ask-to" className="field" placeholder="username, e.g. kwame"
            value={to} onChange={(e) => setTo(e.target.value)} />

          <input id="ask-amt" className="field" placeholder="amount (USDC)" inputMode="decimal"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input id="ask-why" className="field" placeholder="what is it for? e.g. tea" maxLength={140}
            value={purpose} onChange={(e) => setPurpose(e.target.value)} />

          <button onClick={ask} disabled={!!busy} className="btn btn-lg btn-full" style={{ marginTop: 14 }}>
            {busy ?? 'Post request'}
          </button>
          <p className="hint">
            Nothing is locked or escrowed. They pay from their own wallet, and a link to
            your request is copied so you can share it anywhere.
          </p>
        </div>
      )}

      {tab === 'topay' && (
        <div className="stack">
          {actionable.length === 0 && (
            <div className="card empty">
              <div className="empty-mark">◎</div>
              {busy ?? 'Nothing pending. Requests other people make of you show up here.'}
            </div>
          )}
          {actionable.map((r) => renderRequest(r, 'pay'))}
        </div>
      )}

      {tab === 'mine' && (
        <div className="stack">
          {history.length === 0 && direct.length === 0 && (
            <div className="card empty">
              <div className="empty-mark">◎</div>
              {busy ?? 'Nothing here yet. Send someone USDC, or ask them for some.'}
            </div>
          )}
          {history.map((r) => renderRequest(r, 'history'))}
          {direct.map((t) => renderDirect(t))}
        </div>
      )}

      <div className="foot">
        Non-custodial on Arc mainnet ·{' '}
        <a href={`https://explorer.arc.io/address/${REQUESTS}`} target="_blank" rel="noreferrer">
          contracts
        </a>
      </div>
    </div>
  );
}
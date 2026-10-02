import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useChainId, useConnect, useSwitchChain, useWriteContract } from 'wagmi';
import { createPublicClient, http, zeroAddress } from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';
import { arcMainnet } from './chain';
import {
  USDC, REGISTRY, REQUESTS, REGISTRY_ABI, REQUEST_ABI, ERC20_ABI,
  STATUS, usdc, fmtUsdc, short, DAY, type Request,
} from './pay';

const client = createPublicClient({ chain: arcMainnet, transport: http() });

// keccak256("getRequest(uint256)")[:4]
const GET_REQUEST = '0xc58343ef';

// ---------------------------------------------------------------- helpers

async function readRequest(id: bigint): Promise<Request | null> {
  // viem's generic struct decoder mis-handles this contract's two trailing
  // dynamic strings: it reads the offset words as lengths and throws on
  // unsafe integers. Decode the words directly instead — see mainnet-proof.mjs
  // for the confirmed layout.
  try {
    const data = (await client.request({
      method: 'eth_call',
      params: [{ to: REQUESTS, data: (GET_REQUEST + id.toString(16).padStart(64, '0')) as `0x${string}` }, 'latest'],
    })) as `0x${string}`;
    const hex2: string = data.slice(2);
    const b = new Uint8Array(hex2.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex2.substr(i * 2, 2), 16);
    const word = (i: number): bigint => {
      let s = '';
      for (let k = i * 32; k < (i + 1) * 32; k++) s += b[k].toString(16).padStart(2, '0');
      return BigInt('0x' + s || '0');
    };
    // Head/tail: w0 is the struct's byte offset; w3/w4 are the two string
    // offsets relative to it, each pointing at a length word.
    const base = Number(word(0));
    const str = (offsetWord: number): string => {
      const at = base + Number(word(offsetWord));
      let len = 0;
      for (let k = 0; k < 32; k++) len = len * 256 + b[at + k];
      let out = '';
      for (let k = at + 32; k < at + 32 + len; k++) out += String.fromCharCode(b[k]);
      return out;
    };
    const hex = (i: number): `0x${string}` =>
      ('0x' + word(i).toString(16).padStart(40, '0')) as `0x${string}`;
    return {
      id,
      requester: hex(1),
      recipient: hex(2),
      username: str(3),
      purpose: str(4),
      amount: word(5),
      expiresAt: word(6),
      status: Number(word(7)),
      autoRelease: word(8) === 1n,
    };
  } catch (e) {
    console.error('readRequest failed for id', id.toString(), e);
    return null;
  }
}

async function readOutbox(who: `0x${string}`): Promise<bigint[]> {
  const ids = await client.readContract({
    address: REQUESTS, abi: REQUEST_ABI, functionName: 'outbox', args: [who],
  });
  return ids as unknown as bigint[];
}

async function readInbox(who: `0x${string}`): Promise<bigint[]> {
  try {
    const r = await client.readContract({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'inbox', args: [who] });
    return r as unknown as bigint[];
  } catch {
    return [];
  }
}

async function resolveName(u: string): Promise<`0x${string}` | null> {
  const who = await client.readContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'resolve', args: [u],
  });
  return who as unknown as `0x${string}`;
}

// ---------------------------------------------------------------- helpers

/** Status badge class for a request. 1 = Pending, 2 = Released. */
const badgeClass = (status: number): string =>
  status === 1 ? 'badge badge-pending' : status === 2 ? 'badge badge-released' : 'badge badge-cancel';

// ---------------------------------------------------------------- app

export default function Pay() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  // A wallet on any other chain cannot do anything here, so detect it and offer
  // a one-tap switch rather than letting reads fail silently.
  const wagmiChainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  // Read the chain straight from the wallet. wagmi's useChainId reflects the
  // connector's view, which does not always match what the wallet is actually
  // on — and a mismatch here means every read silently returns nothing.
  const [walletChain, setWalletChain] = useState<number | null>(null);

  const readChain = useCallback(async () => {
    const w = window as Window & { ethereum?: { request: (a: unknown) => Promise<unknown> } };
    if (!w.ethereum?.request) return;
    try {
      const hex = (await w.ethereum.request({ method: 'eth_chainId' })) as string;
      setWalletChain(Number(hex));
    } catch {
      /* wallet refused; fall back to wagmi's view */
    }
  }, []);

  useEffect(() => {
    if (!isConnected) { setWalletChain(null); return; }
    void readChain();
    const w = window as Window & {
      ethereum?: {
        on?: (e: string, f: (...a: unknown[]) => void) => void;
        removeListener?: (e: string, f: (...a: unknown[]) => void) => void;
      };
    };
    // Keep stable references: removeListener compares identity, so an inline
    // arrow here would detach the listener on the very next render.
    const onChain = () => void readChain();
    const onAccounts = () => void readChain();
    w.ethereum?.on?.('chainChanged', onChain);
    w.ethereum?.on?.('accountsChanged', onAccounts);
    return () => {
      w.ethereum?.removeListener?.('chainChanged', onChain);
      w.ethereum?.removeListener?.('accountsChanged', onAccounts);
    };
  }, [isConnected, readChain]);

  const chainId = walletChain ?? wagmiChainId;
  const wrongChain = isConnected && chainId !== arcMainnet.id;

  /** Ask the wallet to move to Arc. Falls back to wagmi if the wallet ignores us. */
  const switchToArc = async () => {
    const w = window as Window & {
      ethereum?: { request: (a: unknown) => Promise<unknown> };
    };
    try {
      await w.ethereum?.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x13b2' }],
      });
    } catch (e: unknown) {
      // 4902 = chain not added yet. Offer to add it, which most wallets accept.
      const code = (e as { code?: number })?.code;
      if (code === 4902 && w.ethereum?.request) {
        await w.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x13b2',
            chainName: 'Arc',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            rpcUrls: ['https://rpc.mainnet.arc.io'],
            blockExplorerUrls: ['https://explorer.arc.io'],
          }],
        }).catch(() => { /* user declined */ });
      }
    }
    await readChain();
    void switchChain({ chainId: arcMainnet.id });
  };
  const { writeContractAsync } = useWriteContract();

  const [tab, setTab] = useState<'ask' | 'send' | 'inbox' | 'sent'>('ask');

  // Balances and the connected account's username. Both are read on connect
  // and refreshed after anything that moves money.
  const [balance, setBalance] = useState<bigint | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  const [inboxPending, setInboxPending] = useState<Set<bigint>>(new Set());
  const [step, setStep] = useState<'welcome' | 'claim' | 'ready'>('claim');

  useEffect(() => {
    if (!address) return;
    (async () => {
      await refresh();
      try {
        const who = (await client.readContract({
          address: REGISTRY, abi: REGISTRY_ABI, functionName: 'usernameOf', args: [address],
        })) as unknown as string;
        // No username yet means this is a first run — walk them through claiming one.
        setStep(who && who.length ? 'ready' : 'welcome');
      } catch {
        setStep('welcome');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // claim a username
  const [name, setName] = useState('');
  const [nameState, setNameState] = useState<{ taken?: boolean; mine?: boolean; done?: boolean }>({});

  // ask for money
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [auto, setAuto] = useState(true);

  // send
  const [lookup, setLookup] = useState<`0x${string}` | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [sendAmt, setSendAmt] = useState('');

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [inbox, setInbox] = useState<Request[]>([]);
  const [sent, setSent] = useState<Request[]>([]);

  /** Re-read balance, gas and username. Safe to call after any tx. */
  const refresh = async () => {
    if (!address) return;
    try {
      const [usdcBal, who] = await Promise.all([
        client.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
        client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'usernameOf', args: [address] }),
      ]);
      setBalance(usdcBal);
      const u = (who as unknown as string) ?? '';
      setMyName(u.length ? u : null);
    } catch {
      setBalance(null);
    }
  };

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label); setErr(null); setNote(null);
    try {
      const msg = await fn();
      setNote(msg);
      return true;
    } catch (e: any) {
      setErr(`${e?.shortMessage ?? e?.message ?? 'failed'}`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const claim = () =>
    run('Claiming…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const taken = await client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'isTaken', args: [name.toLowerCase()] });
      if (taken) { setNameState({ taken: true }); throw new Error(`@${name} is already taken`); }
      const h = await writeContractAsync({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'register', args: [name.toLowerCase()] });
      await waitForTransactionReceipt(client, { hash: h });
      setNameState({ done: true });
      setMyName(name.toLowerCase());
      await refresh();
      setStep('ready');
      return `You are now @${name.toLowerCase()}`;
    });

  const ask = () =>
    run('Creating request…', async () => {
      if (!address) throw new Error('Connect a wallet first');
      const units = BigInt(Math.round(parseFloat(amount) * 1e6));
      if (!(units > 0n)) throw new Error('Enter an amount');
      if (!purpose.trim()) throw new Error('Say what it is for');

      const recipient = await resolveName(to.replace(/^@/, '').toLowerCase());
      if (!recipient || recipient === zeroAddress) throw new Error(`No one is @${to}`);

      const approveHash = await writeContractAsync({
        address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [REQUESTS, units],
      });
      await waitForTransactionReceipt(client, { hash: approveHash });
      const h = await writeContractAsync({
        address: REQUESTS, abi: REQUEST_ABI, functionName: 'requestFor',
        args: [to.replace(/^@/, '').toLowerCase(), purpose.trim(), units, BigInt(Math.floor(Date.now() / 1000) + 7 * DAY), auto],
      });
      await waitForTransactionReceipt(client, { hash: h });
      await refresh();
      void loadOutbox();
      const link = `${location.origin}/?r=${h}`;
      try {
        await navigator.clipboard.writeText(link);
        return `Requested ${amount} USDC from @${to.replace(/^@/, '').toLowerCase()} — link copied, send it anywhere`;
      } catch {
        return `Requested ${amount} USDC from @${to.replace(/^@/, '').toLowerCase()}`;
      }
    });

  const send = () =>
    run('Sending…', async () => {
      if (!lookup) throw new Error('Look up a username first');
      const units = BigInt(Math.round(parseFloat(sendAmt) * 1e6));
      const h = await writeContractAsync({
        address: USDC, abi: ERC20_ABI,
        functionName: 'transfer', args: [lookup, units],
      });
      await waitForTransactionReceipt(client, { hash: h });
      await refresh();
      return `Sent ${sendAmt} USDC to @${sendTo.replace(/^@/, '').toLowerCase()}`;
    });

  const find = async () => {
    const who = await resolveName(sendTo.replace(/^@/, '').toLowerCase());
    setLookup(!who || who === zeroAddress ? null : who);
  };

  // Watch for requests the user does not know about yet. Polls the chain so a
  // new request surfaces without opening the app.
  const seen = useRef<Set<string>>(new Set());
  const [alert, setAlert] = useState<{ title: string; body: string } | null>(null);
  const [wantNotify, setWantNotify] = useState(
    () => typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default',
  );

  // A request link dropped into the app goes straight to the Inbox.
  useEffect(() => {
    if (new URLSearchParams(location.search).has('r')) setTab('inbox');
  }, []);

  const poll = useCallback(async () => {
    if (!address) return;
    try {
      const ids = await readInbox(address);
      const pending = new Set<bigint>();
      const fresh: bigint[] = [];
      for (const id of ids) {
        const r = await readRequest(id);
        if (!r || r.status !== 1) continue;
        pending.add(id);
        // First load just records what exists; later polls report what is new.
        if (seen.current.size && !seen.current.has(id.toString())) fresh.push(id);
      }
      if (seen.current.size) {
        const onlyNew = fresh.filter((id) => pending.has(id));
        if (onlyNew.length) {
          const newest = onlyNew[onlyNew.length - 1];
          const r = await readRequest(newest);
          if (r) {
            setAlert({
              title: `${fmtUsdc(r.amount)} USDC requested`,
              body: r.purpose || `From @${r.username}`,
            });
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification(`${fmtUsdc(r.amount)} USDC requested`, {
                body: r.purpose || `From @${r.username}`,
                tag: `send-${newest}`,
              });
            }
          }
        }
      }
      ids.forEach((id) => seen.current.add(id.toString()));
      setInboxPending(pending);
    } catch {
      /* transient RPC failure — retry on the next tick */
    }
  }, [address]);

  // Poll while the tab is visible; pause when it is not.
  useEffect(() => {
    if (step !== 'ready') return;
    void poll();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void poll(); }, 12_000);
    const onVis = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [step, poll]);

  const loadOutbox = async () => {
    if (!address) return;
    const ids = await readOutbox(address);
    const rs = await Promise.all(ids.map(readRequest));
    ids.forEach((id) => seen.current.add(id.toString()));
    setSent(rs.filter((r): r is Request => !!r).reverse());
  };

  const loadInbox = async () => {
    if (!address) return;
    setBusy('Loading…');
    try {
      const ids = await readInbox(address);
      const rs = await Promise.all(ids.map(readRequest));
      ids.forEach((id) => seen.current.add(id.toString()));
      const live = rs.filter((r): r is Request => !!r);
      // Pending first — a request you can act on must not sit below settled
      // history — then most recent first within each group.
      live.sort((a, b) => {
        const ap = a.status === 1 ? 0 : 1;
        const bp = b.status === 1 ? 0 : 1;
        return ap !== bp ? ap - bp : Number(b.id - a.id);
      });
      setInbox(live);
    } finally { setBusy(null); }
  };

  const release = (id: bigint) =>
    run('Releasing…', async () => {
      const h = await writeContractAsync({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'release', args: [id] });
      await waitForTransactionReceipt(client, { hash: h });
      await loadInbox();
      await refresh();
      return `Released request #${id}`;
    });

  const cancel = (id: bigint) =>
    run('Cancelling…', async () => {
      const h = await writeContractAsync({ address: REQUESTS, abi: REQUEST_ABI, functionName: 'cancel', args: [id] });
      await waitForTransactionReceipt(client, { hash: h });
      await loadInbox();
      await loadOutbox();
      await refresh();
      return `Cancelled #${id} — your money is back`;
    });

  // ---------------------------------------------------------------- render

  if (!isConnected) {
    return (
      <div className="connect">
        <div className="card connect-card">
          <div className="mark">S</div>
          <h1>Send USDC by username</h1>
          <p>Ask anyone for USDC and release it with one tap — or send it straight away.</p>
          {connectors.map((c) => (
            <button key={c.id} onClick={() => connect({ connector: c })} className="btn btn-lg btn-full">
              Connect {c.id === 'injected' ? 'browser wallet' : c.name}
            </button>
          ))}
          <div className="connect-note">
            <div className="net-row">
              <span className="pill"><span className="dot" />Arc mainnet · chain {arcMainnet.id}</span>
            </div>
            <p className="net-copy">
              If Arc is not in your wallet yet, connecting will offer to add it. You can
              switch to it any time from the app.
            </p>
            <p className="net-copy">
              Non-custodial. Your USDC sits in the request contract, never with us, and can
              be returned to you at any point before you release it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------ onboarding

  if (step !== 'ready') {
    const suggestions = ['adeeze', 'chidi', 'tunde', 'ngozi', 'ife', 'bola'];
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
            <div className="net-m">
              You are on chain {chainId}. Send runs on Arc mainnet ({arcMainnet.id}).
            </div>
          </div>
          <button className="btn btn-sm" disabled={switching} onClick={switchToArc}>
            {switching ? 'Switching…' : 'Switch to Arc'}
          </button>
        </div>
      )}

        <div className="steps">
          <div className="step step-done">
            <span className="step-n">✓</span>
            <span>Connect wallet</span>
          </div>
          <div className={`step${step === 'claim' ? ' step-now' : ''}`}>
            <span className="step-n">{step === 'claim' ? '2' : '3'}</span>
            <span>Claim a username</span>
          </div>
          <div className="step">
            <span className="step-n">3</span>
            <span>Send or request USDC</span>
          </div>
        </div>

        {balance !== null && (
          <div className="card bal-card">
            <div>
              <div className="bal-amt big">{fmtUsdc(balance)} <span className="bal-unit">USDC</span></div>
              <div className="hint" style={{ marginTop: 4 }}>{short(address!)}</div>
            </div>
          </div>
        )}

        {step === 'welcome' && (
          <div className="card">
            <h2 className="card-h">Welcome to Send</h2>
            <p className="card-p">
              Pay anyone on Arc by username — no addresses to copy, no wrong-network errors.
              USDC is the gas token here, so sending costs nothing in the network fee.
            </p>
            <ul className="feat">
              <li>Claim a username once, then be paid by it</li>
              <li>Request USDC with a reason, release with one tap</li>
              <li>Cancel any time and your money comes straight back</li>
            </ul>
            <button className="btn btn-lg btn-full" onClick={() => setStep('claim')}>
              Get my username →
            </button>
          </div>
        )}

        {step === 'claim' && (
          <div className="card">
            <h2 className="card-h">Pick a username</h2>
            <p className="card-p">This is how people will pay you. It is permanent.</p>
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
            <p className="hint">
              One transaction on Arc mainnet. Your USDC never touches us.
            </p>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- main app

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <div className="mark">S</div>
          <span className="brand-name">Send</span>
        </div>
      {wrongChain && (
        <div className="net-warn" role="alert">
          <div>
            <div className="net-t">Wrong network</div>
            <div className="net-m">
              You are on chain {chainId}. Send runs on Arc mainnet ({arcMainnet.id}).
            </div>
          </div>
          <button className="btn btn-sm" disabled={switching} onClick={switchToArc}>
            {switching ? 'Switching…' : 'Switch to Arc'}
          </button>
        </div>
      )}

        <div className="acct">
          <div className="bal">
            <span className="bal-amt">{balance === null ? '—' : fmtUsdc(balance)}</span>
            <span className="bal-unit">USDC</span>
          </div>
          <div className="wallet">
            {myName ? `@${myName}` : short(address!)}
          </div>
        </div>
      </header>

      {wantNotify && (
        <div className="card notify-card">
          <div>
            <div className="card-h sm">Get notified</div>
            <p className="card-p sm">Allow notifications so a request reaches you without opening this app.</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={async () => {
            await Notification.requestPermission();
            setWantNotify(false);
          }}>Allow</button>
        </div>
      )}

      <div className="tabs" role="tablist">
        {([['ask', 'Ask'], ['send', 'Send'], ['inbox', 'Inbox'], ['sent', 'Sent']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            onClick={() => {
              setTab(k);
              if (k === 'inbox') loadInbox();
              if (k === 'sent') loadOutbox();
            }}
            className={`tab${tab === k ? ' tab-on' : ''}`}>
            {l}
            {k === 'inbox' && inboxPending.size > 0 && <span className="badge-n">{inboxPending.size}</span>}
          </button>
        ))}
      </div>

      {err && <div className="msg msg-err">{err}</div>}
      {note && <div className="msg msg-ok">{note}</div>}

      {alert && (
        <div className="toast" role="status">
          <div className="toast-bell">🔔</div>
          <div className="toast-body">
            <div className="toast-t">{alert.title}</div>
            <div className="toast-m">{alert.body}</div>
          </div>
          <button className="toast-x" onClick={() => setAlert(null)} aria-label="Dismiss">×</button>
          <button className="toast-go" onClick={() => { setTab('inbox'); setAlert(null); }}>View</button>
        </div>
      )}

      {tab === 'ask' && (
        <div className="card">
          <label className="label" htmlFor="ask-to">Ask someone for USDC</label>
          <input id="ask-to" className="field" placeholder="username" value={to} onChange={(e) => setTo(e.target.value)} />
          <input id="ask-amt" className="field" placeholder="amount (USDC)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input id="ask-why" className="field" placeholder="what is it for?" value={purpose} onChange={(e) => setPurpose(e.target.value)} />

          <label className="check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Anyone can release this to me with one tap — turn off if you want to approve it yourself</span>
          </label>

          <button onClick={ask} disabled={!!busy} className="btn btn-lg btn-full">
            {busy ?? 'Request USDC'}
          </button>
          <p className="hint">
            Your USDC is held in the request contract and stays refundable until you release it.
          </p>
        </div>
      )}

      {tab === 'send' && (
        <div className="card">
          <label className="label" htmlFor="send-to">Send to a username</label>
          <div className="row">
            <input id="send-to" className="field" placeholder="username" value={sendTo} onChange={(e) => { setSendTo(e.target.value); setLookup(null); }} />
            <button onClick={find} className="btn btn-ghost">Find</button>
          </div>

          {lookup && (
            <div className="resolved">
              @{(sendTo || '').replace(/^@/, '').toLowerCase()} → {short(lookup)}
            </div>
          )}

          <input id="send-amt" className="field" style={{ marginTop: lookup ? 14 : 0 }} placeholder="amount (USDC)" inputMode="decimal" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} />
          <button onClick={send} disabled={!!busy || !lookup} className="btn btn-lg btn-full" style={{ marginTop: 16 }}>
            {busy ?? 'Send USDC'}
          </button>
        </div>
      )}

      {tab === 'sent' && (
        <div className="stack">
          {sent.length === 0 && (
            <div className="card empty">
              <div className="empty-mark">◎</div>
              {busy ?? 'You have not asked anyone for USDC yet.'}
            </div>
          )}
          {sent.map((r) => (
            <div key={'s' + r.id.toString()} className="card">
              <div className="req-head">
                <span className="req-amt">{usdc(r.amount)} USDC</span>
                <span className={badgeClass(r.status)}>{STATUS[r.status]}</span>
              </div>
              <div className="req-why">{r.purpose}</div>
              <div className="req-from">to {r.username ? `@${r.username}` : short(r.recipient)}</div>
              {r.status === 1 && (
                <div className="req-hint">
                  Held in the contract until @{r.username} accepts. You can take it back any time.
                </div>
              )}
              {r.status === 1 && (
                <div className="req-actions">
                  <button onClick={() => cancel(r.id)} disabled={!!busy} className="btn btn-warn">
                    Cancel &amp; refund me
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'inbox' && (
        <div className="stack">
          {inbox.length === 0 && (
            <div className="card empty">
              <div className="empty-mark">◎</div>
              {busy ?? 'Nothing waiting for you.'}
            </div>
          )}
          {inbox.map((r) => (
            <div key={r.id.toString()} className="card">
              <div className="req-head">
                <span className="req-amt">{usdc(r.amount)} USDC</span>
                <span className={badgeClass(r.status)}>{STATUS[r.status]}</span>
              </div>
              <div className="req-why">{r.purpose}</div>
              <div className="req-from">
                {r.username ? `@${r.username} · ` : ''}requested {short(r.requester)}
              </div>
              {r.status === 1 && (
                <div className="req-hint">
                  This USDC is already held in the contract. Accepting moves it to your wallet.
                </div>
              )}
              {r.status === 1 && (
                <div className="req-actions">
                  <button onClick={() => release(r.id)} disabled={!!busy} className="btn">
                    Accept &amp; receive
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="foot">
        Non-custodial on Arc mainnet ·{' '}
        <a href="https://explorer.arc.io/address/0x285223c45050D7c93b8fF93Cc972580D2DD1f2EF" target="_blank" rel="noreferrer">
          contracts
        </a>
      </div>
    </div>
  );
}

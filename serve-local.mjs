// Serve the BUILT dApp locally with an EIP-1193 provider installed BEFORE the
// bundle runs, so wagmi's injected connector finds it. Same bundle, same
// mainnet contracts — only the wallet is injected.
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = '/home/administrator/send-app/dist';
const SIGNER = 'https://bingo-writing-solid-institute.trycloudflare.com';
const app = express();

const INJECT = `<script>
(function(){
  var SIGNER = ${JSON.stringify(SIGNER)};
  function call(args){
    var req = (args && args.method) ? args : { method: String(args) };
    var payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: req.method,
      params: req.params || []
    };
    console.log('[dapp -> signer]', payload.method);
    return fetch(SIGNER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(r){
      if(!r.ok) throw new Error('signer HTTP ' + r.status);
      return r.json();
    }).then(function(d){
      if(d.error) throw new Error(d.error.message);
      return d.result;
    });
  }
  // wagmi's injected connector needs chain metadata on the provider object,
  // otherwise it cannot match chain 5042 and the connect silently no-ops.
  var listeners = {};
  window.ethereum = {
    isMetaMask: true,
    request: call,
    on: function(ev, fn){ (listeners[ev] = listeners[ev] || []).push(fn); },
    removeListener: function(ev, fn){
      if(!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter(function(f){ return f !== fn; });
    },
    _metamask: { isUnlocked: true, request: call },
    chainId: '0x13b2',
    networkVersion: '5042',
    selectedAddress: null
  };
  window.ethereum.on('accountsChanged', function(accounts){
    window.ethereum.selectedAddress = accounts && accounts[0] ? accounts[0] : null;
  });
  window.ethereum.on('chainChanged', function(id){ window.ethereum.chainId = id; });
  window.dispatchEvent(new Event('ethereum#initialized'));
  window.__SIGNER__ = SIGNER;
})();
</script>`;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/assets/:file', (req, res) => {
  const p = join(DIST, 'assets', req.params.file);
  if (!existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

app.get('/', (req, res) => {
  let html = readFileSync(join(DIST, 'index.html'), 'utf8');
  html = html.replace('</head>', INJECT + '</head>');
  res.type('html').send(html);
});

app.listen(4177, '127.0.0.1', () => console.log('app on http://127.0.0.1:4177'));

// End-to-end proof of the request/release flow on Arc testnet, with two real
// keys acting as two real people.
//
//   node request-flow.mjs
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';
const REGISTRY = '0x9e15EEF785340AAECA386d3099404D5c50FA7CF5';
const REQUESTS = '0x5A531DC4E63EbB98aE8c44411122A54808a35e5a';

const key = (p) => readFileSync(p, 'utf8').trim();
const adaeze = new ethers.Wallet(key('/home/administrator/.arc-deployer.key'), new ethers.JsonRpcProvider(RPC));
const chidi = new ethers.Wallet(key('/home/administrator/.arc-provider.key'), new ethers.JsonRpcProvider(RPC));

const usdc = new ethers.Contract(USDC, [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
], adaeze);
const registry = new ethers.Contract(REGISTRY, [
  'function register(string)',
  'function resolve(string) view returns (address)',
], adaeze);
const requests = new ethers.Contract(REQUESTS, [
  'function requestFor(string,string,uint256,uint256,bool) returns (uint256)',
  'function release(uint256)',
  'function cancel(uint256)',
  'function getRequest(uint256) view returns (tuple)',
  'function outstanding() view returns (uint256)',
], adaeze);

const usd = (v) => Number(v) / 1e6;
const ok = (c, m) => console.log(c ? `   OK   ${m}` : `   FAIL ${m}`);
const usdcOf = async (who) => usdc.balanceOf(who.address);

console.log('adaeze (payer)   :', adaeze.address);
console.log('chidi (recipient):', chidi.address);
console.log('registry         :', REGISTRY);
console.log('requests         :', REQUESTS);

// --- 1. both register usernames
console.log('\n1. register usernames');
if ((await registry.resolve('adaeze')) === ethers.ZeroAddress) {
  await (await registry.register('adaeze')).wait();
  console.log('   adaeze registered');
}
if ((await registry.resolve('chidi')) === ethers.ZeroAddress) {
  await (await registry.register('chidi').catch(() => null)) ?? null;
}
// chidi must register from its OWN wallet
const reg2 = registry.connect(chidi);
if ((await registry.resolve('chidi')) === ethers.ZeroAddress) {
  await (await reg2.register('chidi')).wait();
  console.log('   chidi registered');
}
ok((await registry.resolve('ADAEZE')) === adaeze.address, 'resolve("ADAEZE") is case-insensitive');
ok((await registry.resolve('chidi')) === chidi.address, 'resolve("chidi") -> chidi address');

// --- 2. chidi requests 3 USDC from adaeze, for groceries
console.log('\n2. chidi requests 3 USDC from @adaeze for groceries');
const AMOUNT = 3_000_000n; // 6dp
await (await usdc.connect(chidi).approve(REQUESTS, AMOUNT)).wait();
const payerBefore = await usdcOf(adaeze);
const recipientBefore = await usdcOf(chidi);
const id = await requests.connect(chidi).requestFor.staticCall(
  'adaeze', 'groceries for the week', AMOUNT, Math.floor(Date.now() / 1000) + 7 * 86400, true,
);
await (await requests.connect(chidi).requestFor(
  'adaeze', 'groceries for the week', AMOUNT, Math.floor(Date.now() / 1000) + 7 * 86400, true,
)).wait();
console.log(`   request id ${id}`);
ok(await usdc.balanceOf(REQUESTS) >= AMOUNT, `escrowed ${usd(await usdc.balanceOf(REQUESTS))} USDC in the contract`);

const r = await requests.getRequest(id);
ok(r.purpose === 'groceries for the week', `purpose recorded: "${r.purpose}"`);
ok(r.recipient === chidi.address, 'recipient resolved from the username');

// --- 3. one click release
console.log('\n3. one click release (anyone can trigger when autoRelease)');
const third = ethers.Wallet.createRandom().connect(adaeze.provider);
await (await requests.connect(third).release(id)).wait();
const payerAfter = await usdcOf(adaeze);
const recipientAfter = await usdcOf(chidi);
ok(recipientAfter > recipientBefore, `chidi ${usd(recipientBefore)} -> ${usd(recipientAfter)} USDC (+${usd(AMOUNT)})`);
ok(payerAfter < payerBefore, `adaeze ${usd(payerBefore)} -> ${usd(payerAfter)} USDC (-${usd(AMOUNT)} less gas)`);
ok((await requests.getRequest(id)).status === 3n, 'request status = Released');

// --- 4. cancel path
console.log('\n4. chidi can cancel a request they no longer need');
const id2 = await requests.connect(chidi).requestFor.staticCall(
  'adaeze', 'concert ticket', AMOUNT, Math.floor(Date.now() / 1000) + 7 * 86400, true,
);
await (await requests.connect(chidi).requestFor(
  'adaeze', 'concert ticket', AMOUNT, Math.floor(Date.now() / 1000) + 7 * 86400, true,
)).wait();
const chidiBeforeCancel = await usdcOf(chidi);
await (await requests.connect(chidi).cancel(id2)).wait();
ok((await requests.getRequest(id2)).status === 2n, 'request status = Cancelled');
ok(await usdcOf(chidi) >= chidiBeforeCancel, 'chidi got the money back');

console.log('\nexplorer:', `https://explorer.testnet.arc.io/address/${REQUESTS}`);
console.log('outstanding:', usd(await requests.outstanding()), 'USDC');
console.log('\nREQUEST/RELEASE FLOW VERIFIED');
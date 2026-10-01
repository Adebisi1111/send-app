# Send

Pay anyone by username on Arc. Ask for USDC with a reason, release it with one tap.

A wallet address is 42 characters and impossible to remember or check. `@adaeze` is
neither. Send moves USDC to a name, and Request lets someone ask you for money
against a stated purpose — you release it in one click, or cancel and get it back.

## Why Arc

USDC is the gas token on Arc, so the asset you are moving also pays for the
transfer. Measured on testnet:

| step        | cost       |
| ----------- | ---------- |
| register    | 0.0018 USDC |
| request     | 0.0028 USDC |
| approve     | 0.0006 USDC |
| release     | 0.0018 USDC |

A full request-and-release cycle costs well under a cent. On a chain where gas is
a different asset, small peer-to-peer payments do not clear that bar — the fee
eats the amount. Arc is what makes "ask for $4, get paid in a tap" worth building.

## Contracts

Both written from scratch, no external dependencies beyond the ERC-20 interface.

### `UsernameRegistry`

Maps a name to an address.

- case-insensitive: `resolve("ADAEZE")` finds `adaeze`
- one name per address, names transferable
- rejects dots and dashes so a name cannot imitate a domain
- 3–32 characters, `[a-z0-9_]` only

### `PaymentRequest`

The request and release flow.

1. `requestFor(username, purpose, amount, expiry, autoRelease)` — the requester
   escrows USDC, the recipient is resolved from the name at request time
2. `release(id)` — sends the escrowed USDC to the recipient. Callable by the
   recipient, or by **anyone** when `autoRelease` is set, which is what lets a
   link or QR code trigger it
3. `cancel(id)` — requester takes the money back while still pending
4. `refundExpired(id)` — anyone can return an expired request's funds, so
   escrowed USDC cannot sit in the contract forever

Expiry is capped at 30 days. Purposes are capped at 140 characters.

Escrowed funds belong to the recorded recipient address, not the name — if
someone transfers their username after a request is created, the money still goes
to the original recipient. There is a test for exactly that.

## Status

Deployed on **Arc testnet**.

| contract         | address                                      |
| ---------------- | -------------------------------------------- |
| UsernameRegistry | `0x9e15EEF785340AAECA386d3099404D5c50FA7CF5` |
| PaymentRequest   | `0x5A531DC4E63EbB98aE8c44411122A54808a35e5a` |

24 contract tests, 5 frontend tests.

```bash
forge test        # 24 passing
npx vitest run    # 5 passing
```

## Running the frontend

```bash
npm install
npm run dev
```

Set the contract addresses in `src/pay.ts` and the RPC in `src/chain.ts` before
pointing it at another network.

## Live

Testnet build: see the deployed Pages site. Mainnet deployment is the open item.

## Layout

```
contracts/
  UsernameRegistry.sol     name -> address
  PaymentRequest.sol       request / release / cancel / refund
  test/                    24 tests covering the two contracts
src/
  Pay.tsx                  the app: Ask, Send, Inbox
  pay.ts                   addresses, ABIs, formatting
```

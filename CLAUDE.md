# nodes7comm

TypeScript library published on npm to communicate with Siemens S7-300/400/1200/1500 PLCs using the S7 protocol over ISO-on-TCP (port 102). It is a port of [nodeS7](https://github.com/plcpeople/nodeS7). It has no runtime dependencies and must stay that way.

## Commands

- `npm run build`: compiles `src/` → `lib/` with `tsc` (`lib/` is in `.gitignore`).
- `npx tsc --noEmit`: type-check.
- `npm run lint`: ESLint 10 with flat config (`eslint.config.js`), typescript-eslint, and prettier as a rule. It checks the `.ts` files and the `.js` config files.
- `npm test`: builds, type-checks the public API with `tsc -p test/types` (`test/types/api.ts`, checked against `lib/*.d.ts`, never run), and runs the `test/` suite with `node:test` against a simulated PLC. Takes about 4 s. Tests that wait for a reconnection pass a short `reconnectDelay`; only "waits before retrying when the connection is refused" keeps the 2 s default, to check it.
- A single file or test: `npx tsc && node --test --test-name-pattern="<name>" test/<file>.test.ts`.
- Development needs Node ≥22.18, which runs TypeScript without compiling; the tests rely on it. People installing the package only need what `engines` says.
- There is no script to test against a real PLC. Hardware testing happens in the author's own projects that use this library.

## Architecture

Everything lives in a single class, `NodeS7Comm` (`src/nodes7comm.ts`, ~2400 lines), which extends `EventEmitter`. Internal types are in `src/types/`. `src/index.ts` only exports `NodeS7Comm` and `Nodes7CommConfig`; everything else is private. The class stays in a single file by the author's decision: don't propose splitting it into modules.

**Connection** (`connectNow`): TCP (`initTCPConnect`) → COTP connection request/confirm (`initISOConnect` / `onISOConnectReply`) → PDU negotiation (`initPDUConnect` / `onPDUReply`, which sets `maxPDU` and `maxParallel`) → `s7comm` state → `connected` event.

**Reading**: `readTags` → `stringToS7Addr` (parses addresses such as `DB1,REAL4` or `M0.0`) → `prepareReadPacket` (sorts, groups nearby addresses when `optimize` is on, splits blocks larger than `maxByteRequest` into several *parts* sharing a `readRequestSequence`, and packs what fits in the PDU) → `sendReadPacket` (respects `maxParallel`; the rest goes to `requestQueue`) → `onResponse` → `readResponse` → `BufferToAddressValue`. Each address keeps its own `promiseResolve`/`promiseReject`, and `readTags` returns a `Promise.all` of them.

**Writing**: same pattern with `prepareWritePacket` / `bufferizeValue` / `sendWritePacket` / `writeResponse`.

## Protocol caveats

- The offsets and magic numbers (`dataPointer = 21`, the `readReqHeader`/`writeReqHeader`/`connectReq`/`negotiatePDU` headers, the fill bytes for odd lengths, `maxByteRequest = 4 * floor((maxPDU - 18) / 4)`) come from nodeS7 and the protocol. Don't "clean them up" without a test that covers the case.
- Sequence numbers wrap after 32767.
- Every connection step must settle. A step that times out emits `connect-timeout` and rejects with the private `CONNECT_TIMED_OUT` symbol, which `connectNow` swallows so no extra `error` is emitted. ISO and PDU timeouts also call `closeTimedOutConnection()`, which closes the socket when `autoReconnect` is off. `test/helpers/fake-plc.ts` has `captureConnectAttempt` / `settlesWithin` to check that an attempt ends.
- `sendReadPacket`/`sendWritePacket` build every request in the shared `readReq`/`writeReq` buffers, so they must pass `socket.write` a copy (`Buffer.from(...)`), never a view: Node keeps the reference until the bytes go out, and the next packet would overwrite them. `requests.test.ts` ("when the socket cannot send right away") holds the writes to prove it.
- `disconnect()` sets `disconnectRequested`, which blocks every path back to a connection (`connectNow` checks it at the start and after each awaited step, and `scheduleReconnect` too); `initiateConnection()` clears it. Any new code that reconnects later, or sends from a timer, must check it as well. `rejectAllPending` rejects the queue and the sent packets and clears their timeouts. Each connection step (`initTCPConnect`, `initISOConnect`, `initPDUConnect`) stores its `reject` in `abortConnecting`, and `disconnect()` calls it, so an attempt in progress ends instead of staying pending forever on a destroyed socket; a new connection step must do the same. While the socket is closing, `disconnecting` holds that promise and `initiateConnection()` waits for it: `connectNow` → `connectionCleanup` calls `removeAllListeners('close')` on the old socket, which would otherwise drop the listener `disconnect()` is waiting on.
- `sendNextRequest` sends synchronously (it used to defer with `setTimeout(0)`). That's safe because the new packet is appended to the sent arrays and doesn't move the index of the response being processed.
- Reads and writes reject with `S7Error` (exported, defined at the top of `nodes7comm.ts`), never with strings. `validateReadResponse` / `validateWriteResponse` record why an item failed in `responseFailure` (`TIMEOUT`, `PLC_ERROR` with `plcCode`, `INVALID_RESPONSE` with `detail`); `rejectReadBlock` / `rejectWriteBlock` turn it into one `S7Error` per tag with `failureToError`. Items after one that couldn't be decoded have no failure of their own and get `unknownFailure(data)`. Queue and connection rejections go through `rejectRequest(request, tag => new S7Error(...))`. Programming errors (invalid address, mismatched write value) stay plain `Error`. `PLC_RETURN_CODES` holds the texts; on the real PLC, a DB that isn't there answers 0x0a and an address past the end of a DB 0x05.
- The `error` event only carries connection errors (request errors reject their own promise). Always emit it through `emitError`: with no listener it writes to stderr instead of letting EventEmitter throw, which inside the async `connectNow` would end the process. Never call `this.emit('error', ...)` directly.
- Reconnection: a failed connection attempt (`connectError`, ISO/PDU timeouts, invalid PDU reply) always goes through `scheduleReconnect`, which waits `reconnectDelay` (the config option of the same name, 2 s by default). `connectionReset` reconnects immediately and is only meant for a connection that was already established. Calling it from a failed attempt brings back the tight reconnect loop.
- TCP is a stream: once connected, `onData` accumulates the bytes in `receiveBuffer` and passes `onResponse` exactly one complete TPKT packet at a time (length in bytes 2-3). The handshake replies (`initISOConnect`, `initPDUConnect`) still read a single `data` event; they are small and haven't caused problems, but they are not framed.
- A tag larger than `maxByteRequest` is split into several parts that share a `readRequestSequence`/`writeRequestSequence`, and one packet can mix parts of different tags. `readResponse` and `writeResponse` therefore handle each block of a packet separately, and keep answered packets until every part of their sequence has been answered (`isReadSequenceReceived` / `isWriteSequenceReceived`). Never assume `requestList[0]` describes the whole packet.
- An S7-1200/300 usually negotiates a PDU of 240 (~220 usable bytes per item) and an S7-1500 one of 960. Test with both sizes.

## Tests

- They use Node's built-in runner (`node:test` + `node:assert/strict`), with no dependencies.
- They are written in TypeScript and Node runs them by stripping the types, so only erasable syntax is allowed: no `enum`, `namespace` or parameter properties; type imports use `import type`, and relative imports include the `.ts` extension. `tsc` doesn't check them yet (it only compiles `src/`).
- They import the **compiled** `lib/` (`../lib/index.js`), so they test what gets published. That's why `npm test` builds first.
- `test/helpers/fake-plc.ts` simulates a PLC: memory per area and DB (`plc.db(1)`, `plc.area(AREA.M)`), a log of what it receives (`plc.jobs`, `plc.connectionRequests`), and fault switches (`silent`, `responseDelay`, `responseChunkSize`, `fastAcknowledge`, `itemReturnCode`, `invalidPduReply`, `ignoreConnectionRequests`, `pduSize`, `maxParallel`). It doesn't simulate timers or counters.
- Create clients with `connectClient`/`createClient` (`autoReconnect: false` by default) and `await disposeClients()` in `afterEach`; it calls `disconnect()` on every client. If a test expects a promise to reject during `disconnect()`, attach `assert.rejects(...)` before disconnecting, or Node reports an unhandled rejection.
- Await every client promise: an unhandled rejection crashes the test process.
- Check rejections with `assert.rejects(promise, isS7Error('PLC_ERROR', { plcCode: 0x05, tag: 'DB1,INT0', message: /.../ }))` (from `fake-plc.ts`); every property besides the code is optional.
- The existing tests pin the **current** behaviour, including the odd parts. If a change breaks one of them, it is an API change: that's allowed because the next release is 3.0.0, but it must be intentional. Update the test and record it under `## Breaking Changes` in `Unreleased`.

## Known issues (updated on 2026-11-06)

The ten bugs found on 2026-10-31 are fixed (see `Unreleased` in the CHANGELOG). When a new bug is found, add a test to `test/known-bugs.test.ts` that describes the correct behaviour and pass it `knownBug('what happens instead')` so it's skipped, then list the bug here. To fix one: run its test with `RUN_KNOWN_BUGS=1` and `--test-name-pattern` (one at a time, a bug can crash the process), fix the code, move the test to the file that covers that area without `knownBug(...)`, and delete the entry from this list.

- Unverified (the fake PLC doesn't simulate them, so it needs real hardware): in `S7AddrToBuffer`, the timer/counter branch compares `address.Type === 'TIMER'`, but `Type` is `'T'`/`'C'`, so that branch never runs and timers/counters are requested like plain bytes.

## Planned for 3.0.0 (API changes)

These change public behaviour, so each one must be recorded under `## Breaking Changes` (or as a `feat:`) in `Unreleased` when it's done. Done so far: unhandled `error` events (see `emitError` under Protocol caveats), `disconnect()`, `S7Error` rejections (see Protocol caveats), reads with no tags resolving to `{}` (`readAllTags()` used to return `[]`), typed results (`S7Value`, `Record<tag, S7Value>`), and the `reconnectDelay` option. Nothing else is planned.

## Tooling (updated on 2026-10-31)

- TypeScript is pinned to `~6.0.x` on purpose: typescript-eslint 8 only supports `typescript <6.1.0`, and TypeScript 7 (the Go compiler) isn't supported yet. Before bumping it, check the `peerDependencies` of `typescript-eslint`.
- The package is **ESM-only** (`"type": "module"`); there is no CommonJS build. CommonJS users `require()` the ESM build, which Node supports since 20.19 / 22.12.
- `tsconfig.json` compiles to ES2022 with `module: nodenext`, plus `verbatimModuleSyntax`, `erasableSyntaxOnly` and `rewriteRelativeImportExtensions`. This enforces three things in `src/`:
  - relative imports include the `.ts` extension (`tsc` rewrites it to `.js` in `lib/`);
  - type-only imports use `import type`;
  - no syntax that Node can't strip (`enum`, `namespace`, parameter properties).

  As a result, Node can also run `src/` without compiling.
- The `.d.ts` files in `lib/` keep the `.ts` extensions in their imports (TS doesn't rewrite them). This works for consumers on TS ≥5.0; on TS 4.9 the types degrade to `any`. Verified on 2026-10-31 with TS 4.9, 5.0, 5.4, 5.7, 5.8 and 6.0, in `nodenext` (ESM and CommonJS), `bundler` and `node10` modes. CommonJS with `nodenext` needs TS ≥5.8, as with any ESM-only package. Switching to `.js` specifiers was considered and rejected: it would only add support for TS 4.7–4.9, which are unmaintained.
- `EventEmitter` is imported from `'events'`. In ESM, `import { EventEmitter } from 'stream'` fails: it only worked in CommonJS, through inheritance.
- `.prettierrc.js` is ESM (`export default`) because the package is `"type": "module"`.
- `src/nodes7comm.ts` and `src/types/request.types.ts` have `/// <reference types="node" preserve="true" />`. Don't remove it: without it, the published `.d.ts` files lose their reference to `@types/node` (TS ≥5.5 no longer emits it).
- The interface + class merge of `NodeS7Comm` (typed events) has an `eslint-disable` on purpose. It types `on`, `once`, `off`, `emit`, `addListener`, `removeListener` and `prepend*`. `EventEmitter<Events>` was considered and rejected on 2026-11-07: it needs a generic `EventEmitter` in the consumer's `@types/node`, and the merge gives the same typing with any version.
- Public signatures: `readTags<V extends S7Value = S7Value, T extends string = string>(tags: T | readonly T[]): Promise<Record<T, V>>` (V first, so `readTags<number>(...)` works; T is then `string`, because TypeScript has no partial inference), and `writeTags` has two overloads: one tag with one value, or a tag array with a value array. Any change to them must keep `test/types/api.ts` passing; its `@ts-expect-error` lines catch types that degrade to `any`. Verified on 2026-11-07 with consumers on TS 5.0, 5.4 and 6.0.
- `npm audit` only reports warnings in `minimatch`, pulled in by ESLint and typescript-eslint, with no published fix yet. These are development tools and are not published.

## Conventions

- Code and comments in English. Prettier uses 4 spaces, single quotes, `arrowParens: 'avoid'` and `printWidth: 1200`: long lines are intentional, don't wrap them by hand.
- `.prettierrc.js` and `eslint.config.js` are exact copies of the configuration used in the author's other projects. Keep them identical to that source: don't tweak them just for this repo without asking.
- Conventional Commits (`fix:`, `feat:`, `docs:`, `build:`, `test:`, `style:`, `release:`).
- Work happens on `dev` and is merged into `master`.
- `CHANGELOG.md` is maintained by hand. Each change goes in the `### Unreleased` section (at the top) in the same commit that introduces it, prefixed with its type (`fix:`, `feat:`...). Breaking changes go under its `## Breaking Changes`. On release, `Unreleased` is renamed to the version.
- The next release will be **3.0.0**: there will be no more 2.x releases. Breaking changes to the public API are allowed if they are intentional, and each one is recorded under `## Breaking Changes` in `Unreleased`, because v3 will need a migration guide. The public API is the methods `initiateConnection`, `disconnect`, `readTags`, `writeTags`, `addTags`, `removeTags`, `readAllTags`, `addTranslationTags` and `deleteTranslationTag`, and the events `connected`, `connect-timeout`, `disconnected` and `error`.

## Publishing

- `package.json` has `"files": ["lib"]`, so only `lib/`, README, LICENSE and package.json are published (neither this file nor `test/`).
- There is no `prepublishOnly`: run `npm run build` before `npm publish`, or a stale `lib/` will be published.
- `exports` only exposes the package root (`types` + `default`), and `engines` requires Node `^20.19.0 || >=22.12.0`. Both changes are already recorded in `Unreleased` as breaking.
- Before publishing, test the tarball the way a consumer would: `npm pack`, install it in a temporary project, and check `import`, `require()` and type-checking with TypeScript.

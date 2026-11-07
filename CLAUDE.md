# nodes7comm

TypeScript library published on npm to communicate with Siemens S7-300/400/1200/1500 PLCs using the S7 protocol over ISO-on-TCP (port 102). It is a port of [nodeS7](https://github.com/plcpeople/nodeS7). It has no runtime dependencies and must stay that way.

## Commands

- `npm run build`: compiles `src/` → `lib/` with `tsc` (`lib/` is in `.gitignore`).
- `npx tsc --noEmit`: type-check.
- `npm run lint`: ESLint 10 with flat config (`eslint.config.js`), typescript-eslint, and prettier as a rule. It checks the `.ts` files and the `.js` config files.
- `npm test`: builds and runs the `test/` suite with `node:test` against a simulated PLC. Takes less than 1 s.
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
- A tag larger than `maxByteRequest` is split into several parts that share a `readRequestSequence`/`writeRequestSequence`, and one packet can mix parts of different tags. `readResponse` and `writeResponse` therefore handle each block of a packet separately, and keep answered packets until every part of their sequence has been answered (`isReadSequenceReceived` / `isWriteSequenceReceived`). Never assume `requestList[0]` describes the whole packet.
- An S7-1200/300 usually negotiates a PDU of 240 (~220 usable bytes per item) and an S7-1500 one of 960. Test with both sizes.

## Tests

- They use Node's built-in runner (`node:test` + `node:assert/strict`), with no dependencies.
- They are written in TypeScript and Node runs them by stripping the types, so only erasable syntax is allowed: no `enum`, `namespace` or parameter properties; type imports use `import type`, and relative imports include the `.ts` extension. `tsc` doesn't check them yet (it only compiles `src/`).
- They import the **compiled** `lib/` (`../lib/index.js`), so they test what gets published. That's why `npm test` builds first.
- `test/helpers/fake-plc.ts` simulates a PLC: memory per area and DB (`plc.db(1)`, `plc.area(AREA.M)`), a log of what it receives (`plc.jobs`, `plc.connectionRequests`), and fault switches (`silent`, `responseDelay`, `splitResponses`, `itemReturnCode`, `invalidPduReply`, `ignoreConnectionRequests`, `pduSize`, `maxParallel`). It doesn't simulate timers or counters.
- Create clients with `connectClient`/`createClient` (`autoReconnect: false` by default) and call `disposeClients()` in `afterEach`. Until there is a public `disconnect()`, that helper closes the socket by reaching into the client's private state.
- Await every client promise: an unhandled rejection crashes the test process.
- The existing tests pin the **current** behaviour, including the odd parts (for example, that a timeout rejects with the string `'Timeout'`, or that `readAllTags()` with no tags resolves to `[]`). If a change breaks one of them, it is an API change: that's allowed because the next release is 3.0.0, but it must be intentional. Update the test and record it under `## Breaking Changes` in `Unreleased`.

## Known issues (verified on 2026-10-31; update this list as each one is fixed)

Each bug has a test in `test/known-bugs.test.ts` that describes the correct behaviour and is skipped. To fix one: run its test with `RUN_KNOWN_BUGS=1` and `--test-name-pattern` (one at a time, because several crash the process), fix the code, remove the `knownBug(...)` from the test and delete the entry from this list.

- `addTags([...])` with tags that are already stored calls `splice(index, 1)` with the index of the wrong array: it mutates the caller's array, duplicates tags and skips others.
- `connectNow` doesn't `await` `onPDUReply`. An invalid PDU produces an unhandled rejection (which crashes the process), and `connected` is emitted anyway.
- With `autoReconnect`, an `ECONNREFUSED` reconnects without any delay and produces thousands of `error` events per second.
- `onResponse` assumes each socket `data` event contains complete packets. If a response arrives split across two TCP segments, it disconnects and the request ends with `'Timeout'`.
- `DB12,D40`, the form the README documents for DWord, rejects with `Unknown data type: D`. The README also shows DInt examples (`ID140`, `MD100`, `DB2,D100`) that are actually DWord or don't work; the correct forms are `IDI`/`MDI`/`DB2,DI100`.
- `DB1,STRING0.10` (with `STRING` instead of `S`) computes a length of 0 bytes, sends nothing, and the promise never settles.
- `writeTags('DB1,INT0.3', [-1, 0, 1])` (a single tag as a string with an array value) writes zeros. Only `writeTags(['DB1,INT0.3'], [[-1, 0, 1]])` works.
- `bufferizeValue` uses `writeInt32BE` for DWORD arrays, so values ≥ 2^31 reject with a `RangeError`.
- Unverified: in `S7AddrToBuffer`, the timer/counter branch compares `address.Type === 'TIMER'`, but `Type` is `'T'`/`'C'`, so that branch never runs.
- There is no public method to disconnect.
- Promises reject with strings (`'Timeout'`), not with `Error`.

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
- The interface + class merge of `NodeS7Comm` (typed events) has an `eslint-disable` on purpose; replacing it with `EventEmitter<Events>` changes the public types.
- `npm audit` only reports warnings in `minimatch`, pulled in by ESLint and typescript-eslint, with no published fix yet. These are development tools and are not published.

## Conventions

- Code and comments in English. Prettier uses 4 spaces, single quotes, `arrowParens: 'avoid'` and `printWidth: 1200`: long lines are intentional, don't wrap them by hand.
- `.prettierrc.js` and `eslint.config.js` are exact copies of the configuration used in the author's other projects. Keep them identical to that source: don't tweak them just for this repo without asking.
- Conventional Commits (`fix:`, `feat:`, `docs:`, `build:`, `test:`, `style:`, `release:`).
- Work happens on `dev` and is merged into `master`.
- `CHANGELOG.md` is maintained by hand. Each change goes in the `### Unreleased` section (at the top) in the same commit that introduces it, prefixed with its type (`fix:`, `feat:`...). Breaking changes go under its `## Breaking Changes`. On release, `Unreleased` is renamed to the version.
- The next release will be **3.0.0**: there will be no more 2.x releases. Breaking changes to the public API are allowed if they are intentional, and each one is recorded under `## Breaking Changes` in `Unreleased`, because v3 will need a migration guide. The public API is the methods `initiateConnection`, `readTags`, `writeTags`, `addTags`, `removeTags`, `readAllTags`, `addTranslationTags` and `deleteTranslationTag`, and the events `connected`, `connect-timeout`, `disconnected` and `error`.

## Publishing

- `package.json` has `"files": ["lib"]`, so only `lib/`, README, LICENSE and package.json are published (neither this file nor `test/`).
- There is no `prepublishOnly`: run `npm run build` before `npm publish`, or a stale `lib/` will be published.
- `exports` only exposes the package root (`types` + `default`), and `engines` requires Node `^20.19.0 || >=22.12.0`. Both changes are already recorded in `Unreleased` as breaking.
- Before publishing, test the tarball the way a consumer would: `npm pack`, install it in a temporary project, and check `import`, `require()` and type-checking with TypeScript.

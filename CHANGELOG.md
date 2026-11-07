### Unreleased

- test: Added an automated test suite that runs against a simulated S7 PLC (`npm test`).
- build: Updated the development tooling to TypeScript 6, ESLint 10 and Prettier 3.
- build: Removed ts-node and the manual `src/test/test.ts` script that ran against a real PLC; the automated suite replaces it.
- fix: Reading a tag larger than the negotiated PDU (for example `DB1,S0.254` on an S7-1200) crashed the process. It is now split into several requests and reassembled, including the other tags read in the same call.
- fix: Writing a tag larger than the negotiated PDU rejected with `'Invalid response'` and then crashed the process when the timeout of its second part fired. All parts are now written and the promise resolves once every part is acknowledged.
- fix: A PLC response split across several TCP segments was treated as invalid, so the connection dropped and the request failed with `'Timeout'`. Incoming data is now buffered until each packet is complete.
- docs: The license now includes the copyright notice of nodeS7, which this library is ported from, as its MIT license requires.

## Breaking Changes

- The package is now ESM-only (`"type": "module"`), compiled to ES2022 instead of ES5 CommonJS. CommonJS projects can still use `require('nodes7comm')` thanks to Node's support for `require()` of ES modules.
- Requires Node.js `^20.19.0 || >=22.12.0` (declared in `engines`).
- Added an `exports` map: only the package root can be imported. Deep imports such as `nodes7comm/lib/...` no longer work.
- TypeScript users need TypeScript 5.0 or newer, or 5.8 or newer when importing from CommonJS files with `"module": "nodenext"`.


### v2.0.0

- fix: Error with String data types.
- feat: now the class NodeS7Comm extends EventEmmiter with the events: `connected`, `connect-timeout`, `error`, `disconnected`.
- feat: Added more options like `requestTimeout`, `optimize`, `autoReconnect` and `logLevel`.
- feat: Added `addTranslationTags` and `deleteTranslationTag` functions.

## Breaking Changes

- `S7Comm` class has been renamed. Use `NodeS7Comm`.
- `initiateConnection` callback has been removed. Use `connected` event instead.
- `setTranslationCB` has been removed. Use `addTranslationTags` instead.
- `readItems` has been removed. Use `readTags` instead.
- `writeItems` has been removed. Use `writeTags` instead.
- `addItems` has been removed. Use `addTags` instead.
- `removeItems` has been removed. Use `removeTags` instead.
- `readAllItems` has been removed. Use `readAllTags` instead.


### v1.0.3

- Update docs.

### v1.0.1

- We can read a list of stored Items.
- Update docs.

### v1.0.0

- Each request return a promise.
- One or more request can be requested at time.

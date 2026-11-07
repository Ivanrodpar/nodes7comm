### Unreleased

- feat: Added `disconnect()`. It closes the connection and stops reconnecting, rejects pending reads and writes right away with `Error('Disconnected')`, emits `disconnected`, and resolves once the socket is closed. It's safe to call twice or while connecting, and `initiateConnection()` connects again afterwards.
- test: Added an automated test suite that runs against a simulated S7 PLC (`npm test`).
- build: Updated the development tooling to TypeScript 6, ESLint 10 and Prettier 3.
- build: Removed ts-node and the manual `src/test/test.ts` script that ran against a real PLC; the automated suite replaces it.
- fix: Reading a tag larger than the negotiated PDU (for example `DB1,S0.254` on an S7-1200) crashed the process. It is now split into several requests and reassembled, including the other tags read in the same call.
- fix: Writing a tag larger than the negotiated PDU rejected with `'Invalid response'` and then crashed the process when the timeout of its second part fired. All parts are now written and the promise resolves once every part is acknowledged.
- fix: A PLC response split across several TCP segments was treated as invalid, so the connection dropped and the request failed with `'Timeout'`. Incoming data is now buffered until each packet is complete.
- fix: An invalid reply to the PDU negotiation crashed the process with an unhandled rejection, and `connected` was emitted anyway. It now emits `error` with an `Error` and doesn't emit `connected`.
- fix: When the PLC sent a fast acknowledgement before the PDU negotiation reply, `connected` was emitted before the negotiation finished and the first requests failed. The acknowledgement is now ignored and the client waits for the real reply.
- fix: With `autoReconnect`, a failed connection attempt (for example a refused connection) was retried immediately, in a tight loop that emitted thousands of `error` events per second. Failed attempts are now retried after 2 seconds.
- fix: `addTags()` with an array that included already stored tags removed the wrong elements from the caller's array, stored some tags twice and skipped others. It no longer modifies the array, ignores tags already stored or repeated in the same call, and stores nothing if one of the tags is invalid.
- fix: `writeTags('DB1,INT0.3', [-1, 0, 1])` (a single tag with an array value) silently wrote zeros. The whole array is now written.
- fix: `DB12,D40`, the DWord form documented in the README, rejected with `Unknown data type: D`. `D` now means DWord in data blocks too, as `ID`, `QD` and `MD` already did in the other areas.
- docs: The README showed DWord addresses as DInt examples (`ID140`, `MD100`, `DB2,D100`); they are now `IDI140`, `MDI100` and `DB2,DI100`.
- fix: `DB1,STRING0.10` (`STRING` instead of `S`) was read as an empty item, so no request was sent and the promise never settled. `STRING` now works like `S`, and any address that would read 0 bytes (for example `DB1,S0` without a length) rejects with `Invalid length`.
- fix: Writing a DWORD array with a value of 2^31 or more rejected with a `RangeError`, because arrays were written as signed integers. They are now unsigned, like single DWORD values.
- fix: A connection error with no `error` listener ended the process (Node throws on an unhandled `error` event, and here it surfaced as an unhandled rejection). The error is now written to stderr instead, even with `logLevel: 'none'`, and `autoReconnect` keeps trying. With a listener, `error` is emitted as before.
- docs: The license now includes the copyright notice of nodeS7, which this library is ported from, as its MIT license requires.

## Breaking Changes

- The package is now ESM-only (`"type": "module"`), compiled to ES2022 instead of ES5 CommonJS. CommonJS projects can still use `require('nodes7comm')` thanks to Node's support for `require()` of ES modules.
- Requires Node.js `^20.19.0 || >=22.12.0` (declared in `engines`).
- Added an `exports` map: only the package root can be imported. Deep imports such as `nodes7comm/lib/...` no longer work.
- TypeScript users need TypeScript 5.0 or newer, or 5.8 or newer when importing from CommonJS files with `"module": "nodenext"`.
- `writeTags` rejects values that don't match their tag, without writing anything: array tags need an array with exactly one value per element (CHAR arrays take a string), and single-value tags reject arrays. Before, those values were written as zeros or garbage, and `writeTags('MB0', [5])` wrote `5`.


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

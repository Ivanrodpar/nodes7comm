### Unreleased

- test: Added an automated test suite that runs against a simulated S7 PLC (`npm test`).
- build: Updated the development tooling to TypeScript 6, ESLint 10 and Prettier 3.

## Breaking Changes

- The compiled code in `lib/` now targets ES2022 instead of ES5. Requires Node.js 16.11 or newer.


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

// Each test describes the expected behaviour of a known bug (see "Known issues" in CLAUDE.md) and is skipped
// until the bug is fixed. A bug can crash the test process instead of failing, so run them one at a time:
//   RUN_KNOWN_BUGS=1 node --test --test-name-pattern="<test name>" test/known-bugs.test.ts
// When a bug is fixed, move its test to the file that covers that area and drop the knownBug(...) option.

import { describe, beforeEach, afterEach } from 'node:test';
import { FakePlc, disposeClients } from './helpers/fake-plc.ts';

// Usage: it('does the right thing', knownBug('what happens instead'), async () => { ... });
export const knownBug = (reason: string): { skip: string | false } => ({ skip: process.env.RUN_KNOWN_BUGS ? false : `known bug: ${reason}` });

describe('known bugs', () => {
    let plc: FakePlc;

    beforeEach(async () => {
        plc = await FakePlc.start();
    });

    afterEach(async () => {
        await disposeClients();
        await plc.stop();
    });

    // No known bugs right now.
});

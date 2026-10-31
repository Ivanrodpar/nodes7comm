// Each test describes the expected behaviour of a known bug (see "Deuda conocida" in CLAUDE.md) and is skipped
// until the bug is fixed. Several of them crash the test process instead of failing, so run them one at a time:
//   RUN_KNOWN_BUGS=1 node --test --test-name-pattern="larger than the PDU" test/known-bugs.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { AREA, FakePlc, connectClient, createClient, disposeClients, getClosedPort } from './helpers/fake-plc.ts';

const knownBug = (reason: string): { skip: string | false } => ({ skip: process.env.RUN_KNOWN_BUGS ? false : `known bug: ${reason}` });

describe('known bugs', () => {
    let plc: FakePlc;

    beforeEach(async () => {
        plc = await FakePlc.start();
    });

    afterEach(async () => {
        disposeClients();
        await plc.stop();
    });

    it('reads a single tag larger than the PDU', knownBug('crashes with a TypeError in readResponse'), async () => {
        const client = await connectClient(plc);
        const text = 'x'.repeat(230);
        plc.db(1).set([254, text.length, ...Buffer.from(text)], 0);
        assert.deepEqual(await client.readTags('DB1,S0.254'), { 'DB1,S0.254': text });
    });

    it('writes a single tag larger than the PDU', knownBug('rejects with "Invalid response", then crashes when the second part times out'), async () => {
        const client = await connectClient(plc);
        const text = 'y'.repeat(230);
        assert.deepEqual(await client.writeTags('DB1,S0.254', text), { 'DB1,S0.254': text });
        assert.deepEqual([...plc.db(1).subarray(0, 256)], [254, text.length, ...Buffer.from(text), ...new Array(24).fill(0x20)]);
    });

    it('addTags with an array keeps the tags that are not stored yet', knownBug('splices the wrong index'), async () => {
        const client = await connectClient(plc);
        client.addTags(['M0.0', 'M0.1']);
        const tags = ['M0.1', 'M0.5'];
        client.addTags(tags);
        assert.deepEqual(tags, ['M0.1', 'M0.5']);
        assert.deepEqual(Object.keys(await client.readAllTags()).sort(), ['M0.0', 'M0.1', 'M0.5']);
    });

    it('emits error and not connected when the PDU negotiation reply is invalid', knownBug('emits connected, then an unhandled rejection crashes the process'), async () => {
        plc.invalidPduReply = true;
        const client = createClient({ port: plc.port });
        let connected = false;
        client.on('connected', () => {
            connected = true;
        });
        const error = once(client, 'error');
        client.initiateConnection();
        await error;
        assert.equal(connected, false);
    });

    it('waits before reconnecting when the connection is refused', knownBug('reconnects immediately, thousands of times per second'), async () => {
        const client = createClient({ port: await getClosedPort(), autoReconnect: true });
        let errors = 0;
        client.on('error', () => {
            errors += 1;
        });
        client.initiateConnection();
        await sleep(500);
        assert.ok(errors < 10, `${errors} error events in 500 ms`);
    });

    it('reassembles a response split across TCP segments', knownBug('drops the connection and rejects after the request timeout'), async () => {
        const client = await connectClient(plc, { requestTimeout: 300 });
        plc.splitResponses = true;
        plc.db(1).writeInt16BE(7, 0);
        assert.deepEqual(await client.readTags('DB1,INT0'), { 'DB1,INT0': 7 });
    });

    it('accepts DB DWord addresses written as in the README (DB12,D40)', knownBug('rejects with "Unknown data type: D"'), async () => {
        const client = await connectClient(plc);
        plc.db(12).writeUInt32BE(0x12345678, 40);
        assert.deepEqual(await client.readTags('DB12,D40'), { 'DB12,D40': 0x12345678 });
    });

    it('accepts STRING as an alias of S', knownBug('computes a length of 0 bytes, sends no request and never settles'), async () => {
        const client = await connectClient(plc);
        plc.db(1).set([10, 2, ...Buffer.from('ok')], 0);
        assert.deepEqual(await client.readTags('DB1,STRING0.10'), { 'DB1,STRING0.10': 'ok' });
    });

    it('writes an array when the tag is passed as a string', knownBug('writes zeros instead of the values'), async () => {
        const client = await connectClient(plc);
        await client.writeTags('DB1,INT0.3', [-1, 0, 1]);
        assert.deepEqual([...plc.db(1).subarray(0, 6)], [0xff, 0xff, 0x00, 0x00, 0x00, 0x01]);
    });

    it('writes DWORD arrays with values of 2^31 or more', knownBug('uses writeInt32BE for DWORD arrays and rejects with a RangeError'), async () => {
        const client = await connectClient(plc);
        await client.writeTags(['MD0.2'], [[0xdeadbeef, 1]]);
        assert.deepEqual([...plc.area(AREA.M).subarray(0, 8)], [0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x01]);
    });
});

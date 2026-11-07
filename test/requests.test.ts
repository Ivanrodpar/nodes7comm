import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeS7Comm } from '../lib/index.js';
import { FakePlc, connectClient, disposeClients } from './helpers/fake-plc.ts';

describe('request building', () => {
    let plc: FakePlc;
    let client: NodeS7Comm;

    beforeEach(async () => {
        plc = await FakePlc.start();
        client = await connectClient(plc);
    });

    afterEach(async () => {
        await disposeClients();
        await plc.stop();
    });

    it('groups nearby addresses of the same DB into one item', async () => {
        plc.db(1).writeInt16BE(-5, 0);
        plc.db(1).writeInt16BE(9, 4);
        plc.db(1).writeFloatBE(1.5, 8);
        assert.deepEqual(await client.readTags(['DB1,INT0', 'DB1,INT4', 'DB1,REAL8']), { 'DB1,INT0': -5, 'DB1,INT4': 9, 'DB1,REAL8': 1.5 });
        assert.equal(plc.jobs.length, 1);
        assert.deepEqual(
            plc.jobs[0].items.map(({ dbNumber, byteOffset, length }) => ({ dbNumber, byteOffset, length })),
            [{ dbNumber: 1, byteOffset: 0, length: 12 }],
        );
    });

    it('sends separate items for different areas and DBs', async () => {
        await client.readTags(['DB1,INT0', 'DB2,INT0', 'MW0']);
        assert.equal(plc.jobs.length, 1);
        assert.equal(plc.jobs[0].items.length, 3);
    });

    it('sends separate items for addresses further apart than the gap tolerance', async () => {
        await client.readTags(['DB1,INT0', 'DB1,INT20']);
        assert.equal(plc.jobs[0].items.length, 2);
    });

    it('sends one item per address when optimize is false', async () => {
        const unoptimized = await connectClient(plc, { optimize: false });
        await unoptimized.readTags(['DB1,INT0', 'DB1,INT2']);
        assert.equal(plc.jobs[0].items.length, 2);
    });

    it('splits many items into several packets that fit the negotiated PDU', async () => {
        const tags = Array.from({ length: 30 }, (_, i) => `DB${i + 1},INT0`);
        tags.forEach((_, i) => plc.db(i + 1).writeInt16BE(i, 0));
        assert.deepEqual(await client.readTags(tags), Object.fromEntries(tags.map((tag, i) => [tag, i])));
        assert.ok(plc.jobs.length > 1);
        for (const job of plc.jobs) {
            assert.ok(job.requestPduLength <= plc.pduSize, `request of ${job.requestPduLength} bytes`);
            assert.ok((job.responsePduLength as number) <= plc.pduSize, `response of ${job.responsePduLength} bytes`);
        }
    });

    it('never has more jobs in flight than the PLC allows', async () => {
        const restricted = await FakePlc.start();
        restricted.maxParallel = 2;
        restricted.responseDelay = 20;
        try {
            const limited = await connectClient(restricted);
            const results = await Promise.all(Array.from({ length: 6 }, (_, i) => limited.readTags(`DB${i + 1},INT0`)));
            assert.equal(results.length, 6);
            assert.equal(restricted.jobs.length, 6);
            assert.equal(restricted.maxInFlight, 2);
        } finally {
            await disposeClients();
            await restricted.stop();
        }
    });

    it('rejects a read when the PLC reports an item error, and keeps the connection', async () => {
        plc.itemReturnCode = () => 0x0a; // Object does not exist
        await assert.rejects(client.readTags('DB1,INT0'));
        plc.itemReturnCode = () => 0xff;
        assert.deepEqual(await client.readTags('DB1,INT0'), { 'DB1,INT0': 0 });
    });

    it('rejects a write when the PLC reports an item error, and keeps the connection', async () => {
        plc.itemReturnCode = () => 0x05; // Address out of range
        await assert.rejects(client.writeTags('DB1,INT0', 7));
        assert.equal(plc.db(1).readInt16BE(0), 0);
        plc.itemReturnCode = () => 0xff;
        await client.writeTags('DB1,INT0', 7);
        assert.equal(plc.db(1).readInt16BE(0), 7);
    });

    describe('TCP segmentation', () => {
        it('reads a response split across TCP segments, including its header', async () => {
            plc.responseChunkSize = 3;
            plc.db(1).writeInt16BE(7, 0);
            assert.deepEqual(await client.readTags('DB1,INT0'), { 'DB1,INT0': 7 });
        });

        it('writes when the response is split across TCP segments', async () => {
            plc.responseChunkSize = 5;
            assert.deepEqual(await client.writeTags('DB1,INT0', -3), { 'DB1,INT0': -3 });
            assert.equal(plc.db(1).readInt16BE(0), -3);
        });

        it('reads several parallel responses that arrive in small segments', async () => {
            plc.responseChunkSize = 7; // Splits each 23-byte response mid-header and mid-data
            [11, 22, 33].forEach((value, i) => plc.db(i + 1).writeInt16BE(value, 0));
            const results = await Promise.all([client.readTags('DB1,INT0'), client.readTags('DB2,INT0'), client.readTags('DB3,INT0')]);
            assert.deepEqual(results, [{ 'DB1,INT0': 11 }, { 'DB2,INT0': 22 }, { 'DB3,INT0': 33 }]);
        });

        it('reads a tag larger than the PDU whose parts arrive in segments', async () => {
            plc.responseChunkSize = 50;
            const text = 'w'.repeat(240);
            plc.db(1).set([254, text.length, ...Buffer.from(text)], 0);
            assert.deepEqual(await client.readTags('DB1,S0.254'), { 'DB1,S0.254': text });
        });

        it('ignores the fast acknowledgement that some PLCs send before each response', async () => {
            plc.fastAcknowledge = true;
            plc.db(1).writeInt16BE(5, 0);
            assert.deepEqual(await client.readTags('DB1,INT0'), { 'DB1,INT0': 5 });
            assert.deepEqual(await client.writeTags('DB1,INT0', 6), { 'DB1,INT0': 6 });
            assert.equal(plc.db(1).readInt16BE(0), 6);
        });
    });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeS7Comm } from '../lib/index.js';
import { FakePlc, connectClient, createClient, disposeClients, isS7Error } from './helpers/fake-plc.ts';

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
        await assert.rejects(client.readTags('DB1,INT0'), isS7Error('PLC_ERROR', { plcCode: 0x0a, tag: 'DB1,INT0', message: /^The PLC rejected DB1,INT0: object does not exist \(code 0x0a\)$/ }));
        plc.itemReturnCode = () => 0xff;
        assert.deepEqual(await client.readTags('DB1,INT0'), { 'DB1,INT0': 0 });
    });

    it('rejects a write when the PLC reports an item error, and keeps the connection', async () => {
        plc.itemReturnCode = () => 0x05; // Address out of range
        await assert.rejects(client.writeTags('DB1,INT0', 7), isS7Error('PLC_ERROR', { plcCode: 0x05, tag: 'DB1,INT0', message: /address out of range \(code 0x05\)/ }));
        assert.equal(plc.db(1).readInt16BE(0), 0);
        plc.itemReturnCode = () => 0xff;
        await client.writeTags('DB1,INT0', 7);
        assert.equal(plc.db(1).readInt16BE(0), 7);
    });

    describe('S7Error', () => {
        it('names the tag that failed when several are read in one call', async () => {
            plc.itemReturnCode = item => (item.dbNumber === 2 ? 0x0a : 0xff); // Only DB2 is missing
            const results = await Promise.allSettled([client.readTags('DB1,INT0'), client.readTags('DB2,INT0')]);
            assert.equal(results[0].status, 'fulfilled');
            assert.equal(results[1].status, 'rejected');
            assert.ok(isS7Error('PLC_ERROR', { plcCode: 0x0a, tag: 'DB2,INT0' })((results[1] as PromiseRejectedResult).reason));
        });

        it('describes a return code it does not know', async () => {
            plc.itemReturnCode = () => 0x42;
            await assert.rejects(client.readTags('MB0'), isS7Error('PLC_ERROR', { plcCode: 0x42, message: /unknown error \(code 0x42\)/ }));
        });

        it('is an Error with a name, so it prints and logs like one', async () => {
            plc.itemReturnCode = () => 0x05;
            const err = await client.readTags('MB0').catch(error => error);
            assert.ok(err instanceof Error);
            assert.equal(err.name, 'S7Error');
            assert.ok(String(err).startsWith('S7Error: The PLC rejected MB0'));
        });

        it('rejects with NOT_CONNECTED when there is no connection', async () => {
            const offline = createClient({ port: plc.port });
            await assert.rejects(offline.readTags('MB0'), isS7Error('NOT_CONNECTED'));
            await assert.rejects(offline.readAllTags(), isS7Error('NOT_CONNECTED'));
            await assert.rejects(offline.writeTags('MB0', 1), isS7Error('NOT_CONNECTED'));
        });

        it('rejects queued requests with CONNECTION_LOST when the connection drops', async () => {
            const restricted = await FakePlc.start();
            restricted.maxParallel = 1;
            restricted.silent = true;
            try {
                const limited = await connectClient(restricted, { requestTimeout: 100 });
                const sent = assert.rejects(limited.readTags('DB1,INT0'), isS7Error('TIMEOUT', { tag: 'DB1,INT0' }));
                const queued = assert.rejects(limited.readTags('DB2,INT0'), isS7Error('CONNECTION_LOST', { tag: 'DB2,INT0' }));
                await Promise.all([sent, queued]);
            } finally {
                await disposeClients();
                await restricted.stop();
            }
        });
    });

    describe('when the socket cannot send right away', () => {
        // Node keeps a reference to the buffer passed to socket.write until it is sent, it doesn't copy it.
        // This holds every write and sends them later, like a slow link would.
        const holdWrites = (client: object): (() => void) => {
            const socket = (client as { client: { write: (chunk: Buffer) => boolean } }).client;
            const write = socket.write.bind(socket);
            const held: Buffer[] = [];
            socket.write = chunk => {
                held.push(chunk);
                return false;
            };
            return () => {
                socket.write = write;
                held.forEach(chunk => write(chunk));
            };
        };

        it('sends every read request intact', async () => {
            const tags = Array.from({ length: 30 }, (_, i) => `DB${i + 1},INT0`); // Two packets, prepared in one go
            tags.forEach((_, i) => plc.db(i + 1).writeInt16BE(i, 0));
            const release = holdWrites(client);
            const read = client.readTags(tags);
            release();
            assert.deepEqual(await read, Object.fromEntries(tags.map((tag, i) => [tag, i])));
        });

        it('sends every write request intact', async () => {
            const tags = Array.from({ length: 30 }, (_, i) => `DB${i + 1},INT0`);
            const release = holdWrites(client);
            const write = client.writeTags(
                tags,
                tags.map((_, i) => i + 100),
            );
            release();
            await write;
            tags.forEach((_, i) => assert.equal(plc.db(i + 1).readInt16BE(0), i + 100));
        });
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

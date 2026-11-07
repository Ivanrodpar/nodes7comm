import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeS7Comm } from '../lib/index.js';
import { AREA, FakePlc, connectClient, disposeClients } from './helpers/fake-plc.ts';

const spaces = (count: number): number[] => new Array(count).fill(0x20);

// Addresses from the "Supported address" table of the README, with the bytes they map to in PLC memory
const cases: { tag: string; value: unknown; area: number; db?: number; offset: number; bytes: number[] }[] = [
    { tag: 'I1.0', value: true, area: AREA.I, offset: 1, bytes: [0x01] },
    { tag: 'Q0.2', value: true, area: AREA.Q, offset: 0, bytes: [0x04] },
    { tag: 'M2.2', value: true, area: AREA.M, offset: 2, bytes: [0x04] },
    { tag: 'DB5,X2.2', value: true, area: AREA.DB, db: 5, offset: 2, bytes: [0x04] },
    { tag: 'IB3', value: 200, area: AREA.I, offset: 3, bytes: [0xc8] },
    { tag: 'MB0', value: 255, area: AREA.M, offset: 0, bytes: [0xff] },
    { tag: 'DB6,B0', value: 42, area: AREA.DB, db: 6, offset: 0, bytes: [0x2a] },
    { tag: 'MC2', value: 'A', area: AREA.M, offset: 2, bytes: [0x41] },
    { tag: 'DB10,C2', value: 'z', area: AREA.DB, db: 10, offset: 2, bytes: [0x7a] },
    { tag: 'QW20', value: 0xbeef, area: AREA.Q, offset: 20, bytes: [0xbe, 0xef] },
    { tag: 'DB10,W220', value: 513, area: AREA.DB, db: 10, offset: 220, bytes: [0x02, 0x01] },
    { tag: 'MI28', value: -2, area: AREA.M, offset: 28, bytes: [0xff, 0xfe] },
    { tag: 'DB10,I28', value: -1234, area: AREA.DB, db: 10, offset: 28, bytes: [0xfb, 0x2e] },
    { tag: 'ID26', value: 0xdeadbeef, area: AREA.I, offset: 26, bytes: [0xde, 0xad, 0xbe, 0xef] },
    { tag: 'DB12,DW40', value: 0x12345678, area: AREA.DB, db: 12, offset: 40, bytes: [0x12, 0x34, 0x56, 0x78] },
    { tag: 'DB12,D40', value: 0xfedcba98, area: AREA.DB, db: 12, offset: 40, bytes: [0xfe, 0xdc, 0xba, 0x98] },
    { tag: 'IDI140', value: -2, area: AREA.I, offset: 140, bytes: [0xff, 0xff, 0xff, 0xfe] },
    { tag: 'MDI100', value: -100000, area: AREA.M, offset: 100, bytes: [0xff, 0xfe, 0x79, 0x60] },
    { tag: 'DB2,DI100', value: 2147483647, area: AREA.DB, db: 2, offset: 100, bytes: [0x7f, 0xff, 0xff, 0xff] },
    { tag: 'MR2000', value: 1.5, area: AREA.M, offset: 2000, bytes: [0x3f, 0xc0, 0x00, 0x00] },
    { tag: 'DB100,R2', value: -0.25, area: AREA.DB, db: 100, offset: 2, bytes: [0xbe, 0x80, 0x00, 0x00] },
    { tag: 'DB100,REAL22', value: 20.5, area: AREA.DB, db: 100, offset: 22, bytes: [0x41, 0xa4, 0x00, 0x00] },
    { tag: 'MLR2004', value: Math.PI, area: AREA.M, offset: 2004, bytes: [0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18] },
    { tag: 'DB101,LR6', value: 2.5, area: AREA.DB, db: 101, offset: 6, bytes: [0x40, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
    // S7 strings: max length, current length, characters padded with spaces up to the max length
    { tag: 'DB99,S0.50', value: 'Hello', area: AREA.DB, db: 99, offset: 0, bytes: [50, 5, ...Buffer.from('Hello'), ...spaces(45)] },
];

describe('reading and writing', () => {
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

    describe('data types', () => {
        for (const { tag, value, area, db, offset, bytes } of cases) {
            it(`reads ${tag}`, async () => {
                plc.area(area, db).set(bytes, offset);
                assert.deepEqual(await client.readTags(tag), { [tag]: value });
            });

            it(`writes ${tag}`, async () => {
                assert.deepEqual(await client.writeTags(tag, value), { [tag]: value });
                assert.deepEqual([...plc.area(area, db).subarray(offset, offset + bytes.length)], bytes);
            });
        }
    });

    describe('arrays', () => {
        const realBytes = [0x3f, 0xc0, 0x00, 0x00, 0xbe, 0x80, 0x00, 0x00, 0x41, 0xa4, 0x00, 0x00];

        it('reads a REAL array', async () => {
            plc.db(1).set(realBytes, 0);
            assert.deepEqual(await client.readTags('DB1,REAL0.3'), { 'DB1,REAL0.3': [1.5, -0.25, 20.5] });
        });

        it('writes a REAL array when tags and values are given as arrays', async () => {
            assert.deepEqual(await client.writeTags(['DB1,REAL0.3'], [[1.5, -0.25, 20.5]]), { 'DB1,REAL0.3': [1.5, -0.25, 20.5] });
            assert.deepEqual([...plc.db(1).subarray(0, 12)], realBytes);
        });

        it('reads an INT array outside a DB', async () => {
            plc.area(AREA.M).set([0xff, 0xff, 0x00, 0x00, 0x00, 0x01], 10);
            assert.deepEqual(await client.readTags('MI10.3'), { 'MI10.3': [-1, 0, 1] });
        });

        it('writes an INT array', async () => {
            await client.writeTags(['DB1,INT0.3'], [[-1, 0, 1]]);
            assert.deepEqual([...plc.db(1).subarray(0, 6)], [0xff, 0xff, 0x00, 0x00, 0x00, 0x01]);
        });

        it('reads and writes DWORD arrays with values of 2^31 or more', async () => {
            await client.writeTags('MD0.2', [0xdeadbeef, 1]);
            assert.deepEqual([...plc.area(AREA.M).subarray(0, 8)], [0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x01]);
            assert.deepEqual(await client.readTags('MD0.2'), { 'MD0.2': [0xdeadbeef, 1] });
        });

        it('writes an array when the tag is passed as a string', async () => {
            assert.deepEqual(await client.writeTags('DB1,INT0.3', [-1, 0, 1]), { 'DB1,INT0.3': [-1, 0, 1] });
            assert.deepEqual([...plc.db(1).subarray(0, 6)], [0xff, 0xff, 0x00, 0x00, 0x00, 0x01]);
        });

        it('writes a CHAR array from a string', async () => {
            await client.writeTags('DB1,C0.5', 'Hello');
            assert.equal(plc.db(1).subarray(0, 5).toString(), 'Hello');
        });

        it('rejects, without writing, an array with the wrong number of values', async () => {
            await assert.rejects(client.writeTags('DB1,INT0.3', [1, 2]), /DB1,INT0.3 expects an array of 3 values/);
            await assert.rejects(client.writeTags(['DB1,INT0.3'], [7]), /DB1,INT0.3 expects an array of 3 values/);
            assert.equal(plc.jobs.length, 0);
        });

        it('rejects, without writing, an array for a single-value tag', async () => {
            await assert.rejects(client.writeTags('DB1,INT0', [5]), /DB1,INT0 expects a single value, not an array/);
            assert.equal(plc.jobs.length, 0);
        });

        it('reads a bit array that spans two bytes', async () => {
            plc.db(1).set([0b00000101, 0b00000010], 0);
            assert.deepEqual(await client.readTags('DB1,X0.0.10'), { 'DB1,X0.0.10': [true, false, true, false, false, false, false, false, false, true] });
        });

        it('reads a CHAR array as a string', async () => {
            plc.db(1).set(Buffer.from('Hello'), 0);
            assert.deepEqual(await client.readTags('DB1,C0.5'), { 'DB1,C0.5': 'Hello' });
        });

        it('reads a STRING array', async () => {
            plc.db(1).set([4, 2, ...Buffer.from('ab'), ...spaces(2), 4, 3, ...Buffer.from('xyz'), ...spaces(1)], 0);
            assert.deepEqual(await client.readTags('DB1,S0.4.2'), { 'DB1,S0.4.2': ['ab', 'xyz'] });
        });

        it('accepts STRING as an alias of S', async () => {
            plc.db(1).set([10, 2, ...Buffer.from('ok')], 0);
            assert.deepEqual(await client.readTags('DB1,STRING0.10'), { 'DB1,STRING0.10': 'ok' });
            await client.writeTags('DB1,STRING20.10', 'hi');
            assert.deepEqual([...plc.db(1).subarray(20, 24)], [10, 2, ...Buffer.from('hi')]);
            plc.db(1).set([4, 1, ...Buffer.from('a'), ...spaces(3), 4, 2, ...Buffer.from('bc'), ...spaces(2)], 40);
            assert.deepEqual(await client.readTags('DB1,STRING40.4.2'), { 'DB1,STRING40.4.2': ['a', 'bc'] });
        });
    });

    describe('tags larger than the PDU', () => {
        it('reads a single tag larger than the PDU', async () => {
            const text = 'x'.repeat(230);
            plc.db(1).set([254, text.length, ...Buffer.from(text)], 0);
            assert.deepEqual(await client.readTags('DB1,S0.254'), { 'DB1,S0.254': text });
            assert.equal(plc.jobs.length, 2);
        });

        it('reads a large tag together with other tags', async () => {
            // The last part of the string travels in the same packet as DB2,INT0
            plc.db(1).set([254, 3, ...Buffer.from('abc')], 0);
            plc.area(AREA.M)[0] = 7;
            plc.db(2).writeInt16BE(-9, 0);
            assert.deepEqual(await client.readTags(['DB1,S0.254', 'MB0', 'DB2,INT0']), { 'DB1,S0.254': 'abc', MB0: 7, 'DB2,INT0': -9 });
        });

        it('reads every address of a large block', async () => {
            // DB1,B10 falls inside the string, so both share one block that is split in two parts
            plc.db(1).set([254, 2, ...Buffer.from('ok')], 0);
            plc.db(1)[10] = 42;
            assert.deepEqual(await client.readTags(['DB1,S0.254', 'DB1,B10']), { 'DB1,S0.254': 'ok', 'DB1,B10': 42 });
        });

        it('reads an array split across three packets', async () => {
            const values = Array.from({ length: 150 }, (_, i) => i * 1.5);
            values.forEach((value, i) => plc.db(1).writeFloatBE(value, i * 4));
            assert.deepEqual(await client.readTags('DB1,REAL0.150'), { 'DB1,REAL0.150': values });
            assert.equal(plc.jobs.length, 3);
        });

        it('reads a tag larger than a 960-byte PDU (S7-1500)', async () => {
            const s1500 = await FakePlc.start();
            s1500.pduSize = 960;
            try {
                const s1500Client = await connectClient(s1500);
                const values = Array.from({ length: 300 }, (_, i) => i - 150);
                values.forEach((value, i) => s1500.db(1).writeInt32BE(value, i * 4));
                assert.deepEqual(await s1500Client.readTags('DB1,DI0.300'), { 'DB1,DI0.300': values });
                assert.equal(s1500.jobs.length, 2);
            } finally {
                await disposeClients();
                await s1500.stop();
            }
        });

        it('rejects a large read with "Timeout" when the PLC stops answering', async () => {
            const impatient = await connectClient(plc, { requestTimeout: 100 });
            plc.silent = true;
            await assert.rejects(impatient.readTags('DB1,S0.254'), reason => reason === 'Timeout');
        });

        it('writes a single tag larger than the PDU', async () => {
            const text = 'y'.repeat(230);
            assert.deepEqual(await client.writeTags('DB1,S0.254', text), { 'DB1,S0.254': text });
            assert.deepEqual([...plc.db(1).subarray(0, 256)], [254, text.length, ...Buffer.from(text), ...spaces(24)]);
            assert.equal(plc.jobs.length, 2);
        });

        it('writes a large tag together with other tags', async () => {
            // The last part of the string travels in the same packet as DB2,INT0
            const text = 'z'.repeat(240);
            assert.deepEqual(await client.writeTags(['DB1,S0.254', 'MB0', 'DB2,INT0'], [text, 7, -9]), { 'DB1,S0.254': text, MB0: 7, 'DB2,INT0': -9 });
            assert.deepEqual([...plc.db(1).subarray(0, 256)], [254, text.length, ...Buffer.from(text), ...spaces(14)]);
            assert.equal(plc.area(AREA.M)[0], 7);
            assert.equal(plc.db(2).readInt16BE(0), -9);
        });

        it('writes an array split across three packets', async () => {
            const values = Array.from({ length: 150 }, (_, i) => i * 1.5);
            await client.writeTags(['DB1,REAL0.150'], [values]);
            assert.deepEqual(
                values.map((_, i) => plc.db(1).readFloatBE(i * 4)),
                values,
            );
            assert.equal(plc.jobs.length, 3);
        });

        it('writes a tag larger than a 960-byte PDU (S7-1500)', async () => {
            const s1500 = await FakePlc.start();
            s1500.pduSize = 960;
            try {
                const s1500Client = await connectClient(s1500);
                const values = Array.from({ length: 300 }, (_, i) => i - 150);
                await s1500Client.writeTags(['DB1,DI0.300'], [values]);
                assert.deepEqual(
                    values.map((_, i) => s1500.db(1).readInt32BE(i * 4)),
                    values,
                );
                assert.equal(s1500.jobs.length, 2);
            } finally {
                await disposeClients();
                await s1500.stop();
            }
        });

        it('rejects a large write with "Timeout" when the PLC stops answering', async () => {
            const impatient = await connectClient(plc, { requestTimeout: 100 });
            plc.silent = true;
            await assert.rejects(impatient.writeTags('DB1,S0.254', 'y'.repeat(230)), reason => reason === 'Timeout');
            // The second part times out after the first one; it used to crash the process at that point
            await new Promise(resolve => setTimeout(resolve, 150));
        });

        it('rejects a large write when the PLC reports an error on one of its parts', async () => {
            plc.itemReturnCode = item => (item.byteOffset > 0 ? 0x05 : 0xff); // Address out of range on the second part
            await assert.rejects(client.writeTags('DB1,S0.254', 'y'.repeat(230)), reason => reason === 'Invalid response');
        });
    });

    describe('several tags and invalid input', () => {
        it('reads several tags in one call', async () => {
            plc.db(100).writeFloatBE(20.5, 22);
            plc.area(AREA.M)[0] = 0b10;
            assert.deepEqual(await client.readTags(['DB100,REAL22', 'M0.0', 'M0.1']), { 'DB100,REAL22': 20.5, 'M0.0': false, 'M0.1': true });
        });

        it('writes several tags in one call', async () => {
            assert.deepEqual(await client.writeTags(['DB1,INT0', 'M0.1'], [7, true]), { 'DB1,INT0': 7, 'M0.1': true });
            assert.equal(plc.db(1).readInt16BE(0), 7);
            assert.equal(plc.area(AREA.M)[0], 0b10);
        });

        it('writes a single bit without changing the other bits of its byte', async () => {
            plc.area(AREA.M)[10] = 0b10100000;
            await client.writeTags('M10.1', true);
            assert.equal(plc.area(AREA.M)[10], 0b10100010);
            await client.writeTags('M10.7', false);
            assert.equal(plc.area(AREA.M)[10], 0b00100010);
        });

        it('rejects when tags and values have different lengths', async () => {
            await assert.rejects(client.writeTags(['MB0', 'MB1'], [1]), /same length/);
        });

        it('rejects unknown addresses', async () => {
            await assert.rejects(client.readTags('XYZ0'), /Failed to find a match for: XYZ0/);
        });

        it('rejects DB bit offsets above 7', async () => {
            await assert.rejects(client.readTags('DB1,X0.8'), /Invalid bit offset/);
        });

        it('rejects a string without a length instead of never settling', async () => {
            await assert.rejects(client.readTags('DB1,S0'), /Invalid length, check your tag: DB1,S0/);
            assert.equal(plc.jobs.length, 0);
        });

        it('rejects tags that are not strings', async () => {
            await assert.rejects(client.readTags(42 as any), /Invalid values provided/);
        });
    });
});

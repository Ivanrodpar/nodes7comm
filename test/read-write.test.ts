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
        disposeClients();
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

        it('rejects tags that are not strings', async () => {
            await assert.rejects(client.readTags(42 as any), /Invalid values provided/);
        });
    });
});

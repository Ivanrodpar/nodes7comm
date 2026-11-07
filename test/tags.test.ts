import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeS7Comm } from '../lib/index.js';
import { AREA, FakePlc, connectClient, disposeClients } from './helpers/fake-plc.ts';

describe('tags', () => {
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

    describe('translation tags', () => {
        it('reads and writes using aliases', async () => {
            client.addTranslationTags({ analog: 'DB100,REAL22', name: 'DB99,S0.50', output: 'Q0.0' });
            assert.deepEqual(await client.writeTags(['analog', 'name', 'output'], [50.5, 'Hello', true]), { analog: 50.5, name: 'Hello', output: true });
            assert.deepEqual(await client.readTags(['analog', 'name', 'output']), { analog: 50.5, name: 'Hello', output: true });
        });

        it('forgets an alias after deleteTranslationTag', async () => {
            client.addTranslationTags({ analog: 'DB100,REAL22' });
            client.deleteTranslationTag('analog');
            await assert.rejects(client.readTags('analog'), /Failed to find a match for: analog/);
        });

        it('throws when an alias does not point to an address', () => {
            assert.throws(() => client.addTranslationTags({ broken: '' }), /Invalid value for a translation/);
        });
    });

    describe('stored tags', () => {
        it('reads every stored tag with readAllTags', async () => {
            plc.area(AREA.I)[0] = 0b1;
            plc.db(1).writeInt16BE(300, 2);
            client.addTranslationTags({ input: 'I0.0', level: 'DB1,INT2' });
            client.addTags(['input', 'level']);
            client.addTags('M5.0');
            assert.deepEqual(await client.readAllTags(), { input: true, level: 300, 'M5.0': false });
        });

        it('ignores a tag that is already stored', async () => {
            const unoptimized = await connectClient(plc, { optimize: false });
            unoptimized.addTags('MB1');
            unoptimized.addTags('MB1');
            await unoptimized.readAllTags();
            assert.equal(plc.jobs[0].items.length, 1);
        });

        it('keeps the new tags of an array that also contains stored ones, without modifying it', async () => {
            client.addTags(['M0.0', 'M0.1']);
            const tags = ['M0.1', 'M0.5'];
            client.addTags(tags);
            assert.deepEqual(tags, ['M0.1', 'M0.5']);
            assert.deepEqual(Object.keys(await client.readAllTags()).sort(), ['M0.0', 'M0.1', 'M0.5']);
        });

        it('stores a tag repeated in the same call only once', async () => {
            const unoptimized = await connectClient(plc, { optimize: false });
            unoptimized.addTags(['MB1', 'MB2', 'MB1']);
            assert.deepEqual(await unoptimized.readAllTags(), { MB1: 0, MB2: 0 });
            assert.equal(plc.jobs[0].items.length, 2);
        });

        it('stores nothing when one of the tags is invalid', async () => {
            assert.throws(() => client.addTags(['MB0', 'XYZ0']), /Failed to find a match for: XYZ0/);
            assert.deepEqual(await client.readAllTags(), []);
        });

        it('stops reading a tag after removeTags', async () => {
            client.addTags(['MB0', 'MB1']);
            client.removeTags('MB0');
            assert.deepEqual(await client.readAllTags(), { MB1: 0 });
        });

        it('resolves readAllTags with an empty array when no tags are stored', async () => {
            // Inconsistent with the object returned otherwise, but it is the current public behaviour
            assert.deepEqual(await client.readAllTags(), []);
        });
    });
});

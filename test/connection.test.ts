import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { FakePlc, connectClient, createClient, disposeClients, getClosedPort } from './helpers/fake-plc.ts';

describe('connection', () => {
    let plc: FakePlc;

    beforeEach(async () => {
        plc = await FakePlc.start();
    });

    afterEach(async () => {
        disposeClients();
        await plc.stop();
    });

    it('emits connected after the ISO connection and the PDU negotiation', async () => {
        const client = await connectClient(plc);
        assert.equal(plc.connectionRequests.length, 1);
        assert.deepEqual(await client.readTags('MB0'), { MB0: 0 });
    });

    it('sends rack 0 and slot 1 in the remote TSAP by default', async () => {
        await connectClient(plc);
        assert.equal(plc.connectionRequests[0].remoteTSAP, 0x0101);
    });

    it('encodes rack and slot in the remote TSAP', async () => {
        await connectClient(plc, { rack: 1, slot: 3 });
        assert.equal(plc.connectionRequests[0].remoteTSAP, 0x0123); // 0x0100 + rack * 32 + slot
    });

    it('uses localTSAP and remoteTSAP when both are given', async () => {
        await connectClient(plc, { localTSAP: 0x1000, remoteTSAP: 0x2001 });
        assert.deepEqual(plc.connectionRequests[0], { localTSAP: 0x1000, remoteTSAP: 0x2001 });
    });

    it('rejects reads and writes while not connected', async () => {
        const client = createClient({ port: plc.port });
        await assert.rejects(client.readTags('MB0'), /Unable to read when not connected/);
        await assert.rejects(client.readAllTags(), /Unable to read when not connected/);
        await assert.rejects(client.writeTags('MB0', 1), /Unable to write when not connected/);
    });

    it('emits error when the TCP connection is refused', async () => {
        const client = createClient({ port: await getClosedPort() });
        const error = once(client, 'error');
        client.initiateConnection();
        const [err] = await error;
        assert.match(err.message, /ECONNREFUSED/);
    });

    it('emits connect-timeout when the PLC never confirms the ISO connection', async () => {
        plc.ignoreConnectionRequests = true;
        const client = createClient({ port: plc.port, requestTimeout: 100 }); // The ISO step uses requestTimeout, not connectionTimeout
        const timeout = once(client, 'connect-timeout');
        client.initiateConnection();
        await timeout;
    });

    it('rejects a read with "Timeout" and emits disconnected when the PLC stops answering', async () => {
        const client = await connectClient(plc, { requestTimeout: 100 });
        const disconnected = once(client, 'disconnected');
        plc.silent = true;
        await assert.rejects(client.readTags('MB0'), reason => reason === 'Timeout');
        const [message] = await disconnected;
        assert.match(message, /Read timeout/);
    });

    it('rejects a write with "Timeout" and emits disconnected when the PLC stops answering', async () => {
        const client = await connectClient(plc, { requestTimeout: 100 });
        const disconnected = once(client, 'disconnected');
        plc.silent = true;
        await assert.rejects(client.writeTags('MB0', 1), reason => reason === 'Timeout');
        const [message] = await disconnected;
        assert.match(message, /Write timeout/);
    });

    it('reconnects after a request timeout when autoReconnect is on', async () => {
        const client = await connectClient(plc, { requestTimeout: 100, autoReconnect: true });
        plc.silent = true;
        const reconnected = once(client, 'connected');
        await assert.rejects(client.readTags('MB0'));
        await reconnected;
        plc.silent = false;
        assert.equal(plc.connectionRequests.length, 2);
        assert.deepEqual(await client.readTags('MB0'), { MB0: 0 });
    });
});

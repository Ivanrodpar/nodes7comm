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

    it('emits error and not connected when the PDU negotiation reply is invalid', async () => {
        plc.invalidPduReply = true;
        const client = createClient({ port: plc.port });
        let connected = false;
        client.on('connected', () => {
            connected = true;
        });
        const error = once(client, 'error');
        client.initiateConnection();
        const [err] = await error;
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid response on PDU reply/);
        await new Promise(resolve => setTimeout(resolve, 50)); // 'connected' used to follow right after
        assert.equal(connected, false);
        await assert.rejects(client.readTags('MB0'), /Unable to read when not connected/);
    });

    it('connects when the PLC sends a fast acknowledgement before the PDU reply', async () => {
        plc.fastAcknowledge = true;
        plc.pduSize = 480;
        const client = await connectClient(plc);
        const text = 'v'.repeat(240); // 256 bytes: a single part with PDU 480, two with PDU 240
        plc.db(1).set([254, text.length, ...Buffer.from(text)], 0);
        assert.deepEqual(await client.readTags('DB1,S0.254'), { 'DB1,S0.254': text });
        assert.equal(plc.jobs.length, 1); // Proves the PDU was really negotiated, not left at a default
    });

    it('waits before retrying when the connection is refused', async () => {
        const client = createClient({ port: await getClosedPort(), autoReconnect: true });
        let errors = 0;
        client.on('error', () => {
            errors += 1;
        });
        client.initiateConnection();
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(errors, 1, `${errors} error events in 500 ms`); // Used to be thousands
    });

    it('reports connection errors on stderr and keeps reconnecting when nobody listens for error', async () => {
        const port = await getClosedPort();
        const client = createClient({ port, autoReconnect: true }); // No 'error' listener on purpose
        const reported: string[] = [];
        const originalConsoleError = console.error;
        console.error = (message: string) => reported.push(message);
        try {
            client.initiateConnection();
            await new Promise(resolve => setTimeout(resolve, 100)); // Used to end the process right here
            assert.equal(reported.length, 1);
            assert.match(reported[0], /Unhandled error event: .*ECONNREFUSED/);

            const revived = await FakePlc.start(port);
            try {
                await once(client, 'connected');
                assert.deepEqual(await client.readTags('MB0'), { MB0: 0 });
            } finally {
                disposeClients();
                await revived.stop();
            }
        } finally {
            console.error = originalConsoleError;
        }
    });

    it('connects once an unreachable PLC comes back', async () => {
        const port = await getClosedPort();
        const client = createClient({ port, autoReconnect: true });
        client.on('error', () => undefined);
        const firstError = once(client, 'error');
        client.initiateConnection();
        await firstError;

        const revived = await FakePlc.start(port); // The PLC comes up while the client waits to retry
        try {
            await once(client, 'connected');
            assert.equal(revived.connectionRequests.length, 1);
            assert.deepEqual(await client.readTags('MB0'), { MB0: 0 });
        } finally {
            disposeClients();
            await revived.stop();
        }
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

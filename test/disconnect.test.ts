import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { FakePlc, connectClient, createClient, disposeClients, getClosedPort, isS7Error } from './helpers/fake-plc.ts';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('disconnect()', () => {
    let plc: FakePlc;

    beforeEach(async () => {
        plc = await FakePlc.start();
    });

    afterEach(async () => {
        await disposeClients();
        await plc.stop();
    });

    it('resolves once the socket is closed, and later requests reject right away', async () => {
        const client = await connectClient(plc);
        await client.disconnect();
        await sleep(20); // Give the PLC side a moment to see the FIN
        assert.equal(plc.connectionCount, 0);
        await assert.rejects(client.readTags('MB0'), /Unable to read when not connected/);
        await assert.rejects(client.writeTags('MB0', 1), /Unable to write when not connected/);
        assert.equal(plc.jobs.length, 0);
    });

    it('emits disconnected once and can be called twice', async () => {
        const client = await connectClient(plc);
        const reasons: string[] = [];
        client.on('disconnected', reason => reasons.push(reason));
        await client.disconnect();
        await client.disconnect();
        assert.deepEqual(reasons, ['Disconnected by disconnect()']);
    });

    it('rejects requests already sent to the PLC immediately, without waiting for their timeout', async () => {
        const client = await connectClient(plc, { requestTimeout: 5000 });
        plc.silent = true;
        // Attach the assertions before disconnecting: the promises reject while disconnect() runs
        const read = assert.rejects(client.readTags('MB0'), isS7Error('DISCONNECTED', { tag: 'MB0' }));
        const write = assert.rejects(client.writeTags('MB1', 1), isS7Error('DISCONNECTED', { tag: 'MB1' }));
        const started = Date.now();
        await client.disconnect();
        await read;
        await write;
        assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
    });

    it('rejects requests still waiting in the queue', async () => {
        plc.maxParallel = 1;
        const client = await connectClient(plc);
        plc.silent = true;
        const reads = ['DB1,INT0', 'DB2,INT0', 'DB3,INT0'].map(tag => assert.rejects(client.readTags(tag), isS7Error('DISCONNECTED', { tag })));
        await sleep(20); // Let the first request reach the PLC
        assert.equal(plc.jobs.length, 1); // One sent, two queued
        await client.disconnect();
        await Promise.all(reads);
    });

    it('rejects every tag of a large read whose parts are in flight', async () => {
        const client = await connectClient(plc);
        plc.silent = true;
        const read = assert.rejects(client.readTags(['DB1,S0.254', 'MB0']), isS7Error('DISCONNECTED'));
        await client.disconnect();
        await read;
    });

    it('does not reconnect afterwards, even with autoReconnect', async () => {
        const client = await connectClient(plc, { autoReconnect: true });
        await client.disconnect();
        await sleep(100);
        assert.equal(plc.connectionRequests.length, 1);
    });

    it('cancels a reconnection that was already scheduled', async () => {
        const port = await getClosedPort();
        const client = createClient({ port, autoReconnect: true });
        client.on('error', () => undefined);
        const failed = once(client, 'error');
        client.initiateConnection();
        await failed; // A retry is now scheduled in 2 s
        await client.disconnect();

        const revived = await FakePlc.start(port);
        try {
            await sleep(2300);
            assert.equal(revived.connectionRequests.length, 0);
        } finally {
            await revived.stop();
        }
    });

    it('stops a connection in progress without emitting connected or connect-timeout', async () => {
        plc.ignoreConnectionRequests = true; // The client waits for the ISO confirmation
        const client = createClient({ port: plc.port, requestTimeout: 100 });
        const events: string[] = [];
        client.on('connected', () => events.push('connected'));
        client.on('connect-timeout', () => events.push('connect-timeout'));
        client.initiateConnection();
        await sleep(30);
        await client.disconnect();
        await sleep(150); // The ISO timeout (100 ms) would have fired by now
        assert.deepEqual(events, []);
    });

    // Wraps the private connectNow() of one client to get the promise of the connection attempt
    const captureConnectAttempt = (client: object): { attempt: () => Promise<void> | undefined } => {
        const internals = client as { connectNow: () => Promise<void> };
        const original = internals.connectNow.bind(client);
        let attempt: Promise<void> | undefined;
        internals.connectNow = () => (attempt = original());
        return { attempt: () => attempt };
    };

    const settlesWithin = async (promise: Promise<void> | undefined, ms: number): Promise<boolean> => {
        const timeout = new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms));
        return Promise.race([promise?.then(() => true) ?? Promise.resolve(false), timeout]);
    };

    for (const step of ['TCP', 'ISO', 'PDU']) {
        it(`ends a connection attempt stuck in the ${step} step instead of leaving it pending`, async () => {
            let port = plc.port;
            if (step === 'TCP') {
                port = 102; // Use a host that never answers, so the TCP connect stays in progress
            } else if (step === 'ISO') {
                plc.ignoreConnectionRequests = true;
            }
            const host = step === 'TCP' ? '10.255.255.1' : '127.0.0.1';
            const client = createClient({ host, port, connectionTimeout: 10000, requestTimeout: 10000 });
            const capture = captureConnectAttempt(client);
            if (step === 'PDU') {
                // Stall the PDU negotiation: the PLC confirms ISO but never answers the setup request
                (plc as unknown as { onSetupCommunication: () => void }).onSetupCommunication = () => undefined;
            }
            client.initiateConnection();
            await sleep(50);
            await client.disconnect();
            assert.equal(await settlesWithin(capture.attempt(), 500), true);
        });
    }

    it('can connect again with initiateConnection()', async () => {
        const client = await connectClient(plc);
        await client.disconnect();
        const reconnected = once(client, 'connected');
        client.initiateConnection();
        await reconnected;
        plc.db(1).writeInt16BE(42, 0);
        assert.deepEqual(await client.readTags('DB1,INT0'), { 'DB1,INT0': 42 });
    });

    it('connects again when initiateConnection() is called without awaiting disconnect()', async () => {
        const client = await connectClient(plc);
        let closed = false;
        const closing = client.disconnect().then(() => (closed = true));
        const reconnected = once(client, 'connected');
        client.initiateConnection();
        await reconnected;
        assert.equal(closed, true); // The old socket closed before the new connection was opened
        await closing;
        assert.equal(plc.connectionRequests.length, 2);
        assert.deepEqual(await client.readTags('MB0'), { MB0: 0 });
    });

    it('lets two concurrent calls both wait for the socket to close', async () => {
        const client = await connectClient(plc);
        const reasons: string[] = [];
        client.on('disconnected', reason => reasons.push(reason));
        await Promise.all([client.disconnect(), client.disconnect()]);
        await sleep(20);
        assert.equal(plc.connectionCount, 0);
        assert.deepEqual(reasons, ['Disconnected by disconnect()']);
    });

    it('does nothing on a client that never connected', async () => {
        const client = createClient({ port: plc.port });
        let disconnected = false;
        client.on('disconnected', () => (disconnected = true));
        await client.disconnect();
        assert.equal(disconnected, false);
    });
});

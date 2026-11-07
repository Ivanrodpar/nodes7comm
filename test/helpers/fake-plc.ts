// A minimal S7 PLC simulator for tests. It speaks just enough ISO-on-TCP / S7comm to answer NodeS7Comm:
// COTP connection confirm, PDU negotiation, read jobs and write jobs.
// Memory areas are plain buffers that tests can preload and inspect. Timers and counters are not simulated.

import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { once } from 'node:events';
import { NodeS7Comm, S7Error } from '../../lib/index.js';
import type { Nodes7CommConfig, S7ErrorCode } from '../../lib/index.js';

export const AREA = { I: 0x81, Q: 0x82, M: 0x83, DB: 0x84 } as const;

// Validator for assert.rejects: an S7Error with this code (and, optionally, these other properties)
export const isS7Error =
    (code: S7ErrorCode, expected: { plcCode?: number; tag?: string; message?: RegExp } = {}) =>
    (err: unknown): boolean => {
        if (!(err instanceof S7Error) || err.code !== code) {
            return false;
        }
        return (expected.plcCode === undefined || err.plcCode === expected.plcCode) && (expected.tag === undefined || err.tag === expected.tag) && (expected.message === undefined || expected.message.test(err.message));
    };

export interface S7Item {
    area: number;
    dbNumber: number;
    byteOffset: number;
    bitOffset: number;
    transportSize: number; // 0x01 = BIT, 0x02 = BYTE
    length: number; // Number of elements of `transportSize`
}

export interface S7Job {
    type: 'read' | 'write';
    seqNum: number;
    items: S7Item[];
    requestPduLength: number; // S7 bytes, without the TPKT and COTP headers
    responsePduLength?: number;
}

const TPKT_COTP_LENGTH = 7;
const FAST_ACKNOWLEDGE = Buffer.from([0x03, 0x00, 0x00, 0x07, 0x02, 0xf0, 0x00]); // COTP data packet without S7 payload

export class FakePlc {
    readonly connectionRequests: { localTSAP: number; remoteTSAP: number }[] = [];
    readonly jobs: S7Job[] = [];

    // Negotiation limits, read when a client connects
    pduSize = 240; // Typical of S7-1200 / S7-300
    maxParallel = 3;

    // Behaviour switches that tests can flip at any time
    ignoreConnectionRequests = false; // Accept TCP but never confirm the ISO connection
    invalidPduReply = false; // Answer the PDU negotiation with a malformed packet
    silent = false; // Receive read/write jobs but never answer them
    responseDelay = 0; // Milliseconds to wait before answering each job
    responseChunkSize = 0; // When > 0, send each job response in TCP segments of this many bytes
    fastAcknowledge = false; // Send an empty COTP data packet before each job response, like older PLCs and WinAC
    itemReturnCode: (item: S7Item) => number = () => 0xff; // 0xff = success, 0x0a = object does not exist...

    inFlight = 0;
    maxInFlight = 0;

    private readonly server: Server = createServer(socket => this.onConnection(socket));
    private readonly sockets = new Set<Socket>();
    private readonly timers = new Set<NodeJS.Timeout>();
    private readonly memory = new Map<string, Buffer>();
    private readonly outgoing: { socket: Socket; chunk: Buffer }[] = [];
    private draining = false;

    // Port 0 picks a free port; pass a port to bring a PLC up where a client is already trying to connect
    static async start(port: number = 0): Promise<FakePlc> {
        const plc = new FakePlc();
        plc.server.listen(port, '127.0.0.1');
        await once(plc.server, 'listening');
        return plc;
    }

    get port(): number {
        return (this.server.address() as AddressInfo).port;
    }

    // Number of TCP connections the PLC currently has open
    get connectionCount(): number {
        return this.sockets.size;
    }

    async stop(): Promise<void> {
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        for (const socket of this.sockets) {
            socket.destroy();
        }
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    // Memory of an area. The DB number only matters for AREA.DB.
    area(area: number, dbNumber: number = 0): Buffer {
        const key = `${area}:${area === AREA.DB ? dbNumber : 0}`;
        let buffer = this.memory.get(key);
        if (!buffer) {
            buffer = Buffer.alloc(65536);
            this.memory.set(key, buffer);
        }
        return buffer;
    }

    db(dbNumber: number): Buffer {
        return this.area(AREA.DB, dbNumber);
    }

    private onConnection(socket: Socket): void {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => undefined);
        socket.setNoDelay(true); // Don't let Nagle merge the chunks that responseChunkSize splits

        // TCP is a stream: split it into TPKT packets using the length in bytes 2-3
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 4 && pending.length >= pending.readUInt16BE(2)) {
                const length = pending.readUInt16BE(2);
                if (length < TPKT_COTP_LENGTH) {
                    socket.destroy();
                    return;
                }
                const packet = pending.subarray(0, length);
                pending = pending.subarray(length);
                this.onPacket(socket, packet);
            }
        });
    }

    private onPacket(socket: Socket, packet: Buffer): void {
        const cotpType = packet[5];
        if (cotpType === 0xe0) {
            this.onConnectionRequest(socket, packet);
        } else if (cotpType === 0xf0 && packet[7] === 0x32) {
            const seqNum = packet.readUInt16BE(11);
            switch (packet[17]) {
                case 0xf0:
                    this.onSetupCommunication(socket, packet, seqNum);
                    break;
                case 0x04:
                    this.onJob(socket, 'read', packet, seqNum);
                    break;
                case 0x05:
                    this.onJob(socket, 'write', packet, seqNum);
                    break;
            }
        }
    }

    private onConnectionRequest(socket: Socket, packet: Buffer): void {
        // TSAP offsets match the fixed layout of NodeS7Comm's connection request
        this.connectionRequests.push({ localTSAP: packet.readUInt16BE(16), remoteTSAP: packet.readUInt16BE(20) });
        if (this.ignoreConnectionRequests) {
            return;
        }
        // Connection confirm: same parameters as the request, with PDU type CC (0xd0)
        const reply = Buffer.from(packet);
        reply[5] = 0xd0;
        socket.write(reply);
    }

    private onSetupCommunication(socket: Socket, packet: Buffer, seqNum: number): void {
        const parallel = Math.min(packet.readUInt16BE(19), this.maxParallel);
        const params = Buffer.alloc(8);
        params[0] = 0xf0;
        params.writeUInt16BE(parallel, 2);
        params.writeUInt16BE(parallel, 4);
        params.writeUInt16BE(Math.min(packet.readUInt16BE(23), this.pduSize), 6);
        const reply = ackData(seqNum, params, Buffer.alloc(0));
        if (this.invalidPduReply) {
            reply.writeUInt16BE(9, 13); // Parameter length no longer matches the packet length
        }
        if (!this.fastAcknowledge) {
            socket.write(reply);
            return;
        }
        // Acknowledge first and reply a bit later, so the client receives them as separate data events
        socket.write(FAST_ACKNOWLEDGE);
        this.schedule(() => {
            if (!socket.destroyed) {
                socket.write(reply);
            }
        }, 5);
    }

    private onJob(socket: Socket, type: 'read' | 'write', packet: Buffer, seqNum: number): void {
        const items = parseItems(packet);
        const job: S7Job = { type, seqNum, items, requestPduLength: packet.length - TPKT_COTP_LENGTH };
        this.jobs.push(job);
        if (this.silent) {
            return;
        }

        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        const respond = (): void => {
            this.inFlight -= 1;
            const response = type === 'read' ? this.read(seqNum, items) : this.write(seqNum, items, packet);
            job.responsePduLength = response.length - TPKT_COTP_LENGTH;
            this.send(socket, response);
        };
        if (this.responseDelay > 0) {
            this.schedule(respond, this.responseDelay);
        } else {
            respond();
        }
    }

    private read(seqNum: number, items: S7Item[]): Buffer {
        const chunks = items.map((item, i) => {
            const code = this.itemReturnCode(item);
            if (code !== 0xff) {
                return Buffer.from([code, 0x00, 0x00, 0x00]);
            }
            const header = Buffer.from([0xff, 0x04, 0x00, 0x00]); // Transport size 0x04: length in bits
            header.writeUInt16BE(item.length * 8, 2);
            const value = this.area(item.area, item.dbNumber).subarray(item.byteOffset, item.byteOffset + item.length);
            const fill = Buffer.alloc(item.length % 2 && i < items.length - 1 ? 1 : 0); // Odd items get a fill byte, except the last one
            return Buffer.concat([header, value, fill]);
        });
        return ackData(seqNum, Buffer.from([0x04, items.length]), Buffer.concat(chunks));
    }

    private write(seqNum: number, items: S7Item[], packet: Buffer): Buffer {
        let pointer = 17 + packet.readUInt16BE(13); // The data section follows the parameters
        const codes = items.map((item, i) => {
            const transportSize = packet[pointer + 1];
            const length = packet.readUInt16BE(pointer + 2);
            const byteLength = transportSize === 0x09 ? length : Math.ceil(length / 8); // 0x03 (BIT) and 0x04 (BYTE) lengths are in bits
            const value = packet.subarray(pointer + 4, pointer + 4 + byteLength);
            pointer += 4 + byteLength + (byteLength % 2 && i < items.length - 1 ? 1 : 0);

            const code = this.itemReturnCode(item);
            if (code === 0xff) {
                const memory = this.area(item.area, item.dbNumber);
                if (item.transportSize === 0x01) {
                    const mask = 1 << item.bitOffset;
                    memory[item.byteOffset] = value[0] & 1 ? memory[item.byteOffset] | mask : memory[item.byteOffset] & ~mask;
                } else {
                    value.copy(memory, item.byteOffset);
                }
            }
            return code;
        });
        return ackData(seqNum, Buffer.from([0x05, items.length]), Buffer.from(codes));
    }

    private send(socket: Socket, packet: Buffer): void {
        const chunks: Buffer[] = this.fastAcknowledge ? [FAST_ACKNOWLEDGE] : [];
        const size = this.responseChunkSize > 0 ? this.responseChunkSize : packet.length;
        for (let i = 0; i < packet.length; i += size) {
            chunks.push(packet.subarray(i, i + size));
        }
        if (chunks.length === 1 && !this.draining) {
            if (!socket.destroyed) {
                socket.write(chunks[0]);
            }
            return;
        }
        this.outgoing.push(...chunks.map(chunk => ({ socket, chunk })));
        this.drain();
    }

    // Write queued chunks one at a time with a short pause, so they reach the client as separate TCP segments and in order
    private drain(): void {
        if (this.draining) {
            return;
        }
        const next = this.outgoing.shift();
        if (!next) {
            return;
        }
        if (!next.socket.destroyed) {
            next.socket.write(next.chunk);
        }
        this.draining = true;
        this.schedule(() => {
            this.draining = false;
            this.drain();
        }, 2);
    }

    private schedule(callback: () => void, ms: number): void {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            callback();
        }, ms);
        this.timers.add(timer);
    }
}

// Item specs start at byte 19, 12 bytes each: 0x12 0x0a 0x10 <transport size> <length:2> <db:2> <area> <bit address:3>
function parseItems(packet: Buffer): S7Item[] {
    const items: S7Item[] = [];
    for (let i = 0; i < packet[18]; i++) {
        const p = 19 + i * 12;
        const bitAddress = packet.readUIntBE(p + 9, 3);
        items.push({
            area: packet[p + 8],
            dbNumber: packet.readUInt16BE(p + 6),
            byteOffset: bitAddress >> 3,
            bitOffset: bitAddress & 7,
            transportSize: packet[p + 3],
            length: packet.readUInt16BE(p + 4),
        });
    }
    return items;
}

// TPKT + COTP + S7 ack_data header (12 bytes), followed by parameters and data
function ackData(seqNum: number, params: Buffer, data: Buffer): Buffer {
    const header = Buffer.from([0x03, 0x00, 0x00, 0x00, 0x02, 0xf0, 0x80, 0x32, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    header.writeUInt16BE(seqNum, 11);
    header.writeUInt16BE(params.length, 13);
    header.writeUInt16BE(data.length, 15);
    const packet = Buffer.concat([header, params, data]);
    packet.writeUInt16BE(packet.length, 2);
    return packet;
}

const openClients = new Set<NodeS7Comm>();

// Clients default to autoReconnect: false so that stopping the FakePlc doesn't start reconnection attempts
export function createClient(config: Partial<Nodes7CommConfig> = {}): NodeS7Comm {
    const client = new NodeS7Comm({ host: '127.0.0.1', autoReconnect: false, ...config });
    openClients.add(client);
    return client;
}

export async function connectClient(plc: FakePlc, config: Partial<Nodes7CommConfig> = {}): Promise<NodeS7Comm> {
    const client = createClient({ port: plc.port, ...config });
    const connected = once(client, 'connected');
    client.initiateConnection();
    await connected;
    return client;
}

export async function disposeClients(): Promise<void> {
    const clients = [...openClients];
    openClients.clear();
    await Promise.all(clients.map(client => client.disconnect()));
}

export async function getClosedPort(): Promise<number> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}

// Wraps the private connectNow() of one client to get the promise of each connection attempt
export function captureConnectAttempt(client: NodeS7Comm): { attempt: () => Promise<void> | undefined } {
    const internals = client as unknown as { connectNow: () => Promise<void> };
    const original = internals.connectNow.bind(client);
    let attempt: Promise<void> | undefined;
    internals.connectNow = () => (attempt = original());
    return { attempt: () => attempt };
}

// True if the promise settles (resolves or rejects) within `ms`
export async function settlesWithin(promise: Promise<void> | undefined, ms: number): Promise<boolean> {
    const timeout = new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms));
    const settled = promise?.then(
        () => true,
        () => true,
    );
    return Promise.race([settled ?? Promise.resolve(false), timeout]);
}

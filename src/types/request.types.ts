import { Address } from './address.types';

export interface SendReadRequest {
    seqNum: number; // Made-up sequence number to watch for.
    requestList: ReadBlock[]; // This will be assigned the object that details what was in the request.
    reqTime: bigint;
    responseBuffer: Buffer;
    sent: boolean; // Have we sent the packet yet?
    rcvd: boolean; // Are we waiting on a reply?
    timeout: NodeJS.Timeout; // The timeout for use with clearTimeout()
    readRequestSequence: number; // If a request are splitter in 2 or more parts
}

export interface SendWriteRequest {
    seqNum: number; // Made-up sequence number to watch for.
    requestList: WriteBlock[]; // This will be assigned the object that details what was in the request.
    reqTime: bigint;
    sent: boolean; // Have we sent the packet yet?
    rcvd: boolean; // Are we waiting on a reply?
    timeout: NodeJS.Timeout; // The timeout for use with clearTimeout()
    writeRequestSequence: number; // Number of parts that the request are splitter in 2 or more parts
}

export interface ReadBlock extends OptimizableReadBlocks {
    parts: number;
    readRequestSequence: number;
    readValue?: Buffer;
    responseBuffer?: Buffer;
}

export interface OptimizableReadBlocks {
    totalbyteLength: number;
    offset: number;
    byteLengthWithFill: number;
    addresses: Address[];
    isOptimized: boolean;
}

export interface WriteBlock {
    parts: number;
    itemReference: S7ItemWrite;
    isOptimized: boolean;
    writeRequestSequence: number;
}

export interface S7PreparedWriteRequest {
    seqNum: number; // Made-up sequence number to watch for.
    writeRequestSequence: number;
    requestList: WriteBlock[]; // This will be assigned the object that details what was in the request.
}

export interface S7PreparedReadRequest {
    seqNum: number; // Made-up sequence number to watch for.
    readRequestSequence: number;
    requestList: ReadBlock[]; // This will be assigned the object that details what was in the request.
}

export interface S7ItemWrite {
    address: Address;
    writeResponse: number;
    writeQuality: string[] | string;
    writeBuffer: Buffer;
    validResponseBuffer: boolean;
    quality: string[] | string;
    writeValue: any;
    valid: boolean;
    errCode: string;
    resultReference: undefined;
}

export interface RequestQueue {
    request: S7PreparedReadRequest | S7PreparedWriteRequest;
    action: 'read' | 'write';
}

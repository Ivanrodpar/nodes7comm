import { connect, Socket } from 'net';
import { format } from 'util';

export class S7Comm {
    private silentMode: boolean = false; // If true, hidde all logs
    private effectiveDebugLevel: number = 0; // Only show logs equal or lower that this number

    private readonly writeReqHeader = Buffer.from([0x03, 0x00, 0x00, 0x1f, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x08, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x05, 0x01]);
    private readonly readReqHeader = Buffer.from([0x03, 0x00, 0x00, 0x1f, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x08, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x04, 0x01]);
    private readonly connectReq = Buffer.from([0x03, 0x00, 0x00, 0x16, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x02, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, 0x02]);
    private readonly negotiatePDU = Buffer.from([0x03, 0x00, 0x00, 0x19, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x08, 0x00, 0x08, 0x03, 0xc0]);

    private readonly maxGap: number = 5; // This is the byte tolerance for optimize
    private readonly requestMaxParallel: number = 8; // Our expected parrallels jobs
    private readonly requestMaxPDU: number = 960; // Our expected bytes size that we can send to the PLC

    private readReq = Buffer.alloc(1500);
    private writeReq = Buffer.alloc(1500);

    private client: Socket | undefined = undefined;
    private isoConnectionState: ConnectionState = 'disconnected';
    private maxPDU: number = 960;
    private maxParallel: number = 8;
    private parallelJobsNow: number = 0;
    private doNotOptimize: boolean = false;
    private connectCallback: Function | undefined = undefined;

    private readonly globalTimeout: number = 1500; // Each packet sent to the PLC has a timeout that trigger a timeout function

    private connectTimeout: number | undefined = undefined; // setTimeout function
    private PDUTimeout: number | undefined = undefined; // setTimeout function
    private reconnectTimer: number | undefined = undefined; // setTimeout function

    private lastError: string | undefined; // Save the last error here

    private rack: number = 0;
    private slot: number = 1;
    private localTSAP: number | undefined = undefined;
    private remoteTSAP: number | undefined = undefined;

    private requestQueue: RequestQueue[] = [];
    private sentReadPacketArray: SendReadRequest[] = []; // Read packets sent, and waiting for response
    private sentWritePacketArray: SendWriteRequest[] = []; // Write packets sent, and waiting for response

    private masterSequenceNumber: number = 0; // This increment on every packet sent to the PLC, whit them we can indendify each ones
    private readRequestSequence: number = 0; // This increment on every read packet that are not splitter due a quantity of bytes that we can send, whit them we can identify parts
    private writeRequestSequence: number = 0; // This increment on every write packet that are not splitter due a quantity of bytes that we can send, whit them we can identify parts

    private translationCB: Function = this.doNothing;
    private ConnectionConfig: ConnectionConfig;
    private connectionId: string | undefined = undefined;

    private connectCBIssued: boolean = false;

    public constructor(ConnectionConfig: ConnectionConfig) {
        if (typeof ConnectionConfig.silentMode !== 'undefined') {
            this.silentMode = ConnectionConfig.silentMode;
        }
        if (typeof ConnectionConfig === 'undefined') {
            ConnectionConfig = { port: 102, host: '0.0.0.0' };
        }
        if (typeof ConnectionConfig.rack !== 'undefined') {
            this.rack = ConnectionConfig.rack;
        }
        if (typeof ConnectionConfig.slot !== 'undefined') {
            this.slot = ConnectionConfig.slot;
        }
        if (typeof ConnectionConfig.localTSAP !== 'undefined') {
            this.localTSAP = ConnectionConfig.localTSAP;
        }
        if (typeof ConnectionConfig.remoteTSAP !== 'undefined') {
            this.remoteTSAP = ConnectionConfig.remoteTSAP;
        }
        if (typeof ConnectionConfig.connectionName === 'undefined') {
            this.connectionId = ConnectionConfig.host + ' S' + this.slot;
        } else {
            this.connectionId = ConnectionConfig.connectionName;
        }
        this.ConnectionConfig = ConnectionConfig;
        this.connectCBIssued = false;
    }

    private outputLog(txt: string | {}, debugLevel?: number, id?: string): void {
        if (this.silentMode) return;

        let idtext;
        if (typeof id === 'undefined') {
            idtext = '';
        } else {
            idtext = ' ' + id;
        }
        if (typeof debugLevel === 'undefined' || this.effectiveDebugLevel >= debugLevel) {
            console.log('[' + process.hrtime.bigint() + idtext + '] ' + format(txt));
        }
    }

    private doNothing(arg: string | number | boolean | (string | number | boolean)[]): string | number | boolean | (string | number | boolean)[] {
        return arg;
    }

    private rejectAllRequestQueue(): void {
        this.outputLog('We detect a connection error, we are rejecting all request');
        this.lastError = 'We detect a connection error, we are rejecting all request';
        for (let i = 0; i < this.requestQueue.length; i++) {
            if (this.requestQueue[i].action === 'read') {
                const req = this.requestQueue[i].request as SendReadRequest;
                for (let u = 0; u < req.requestList.length; u++) {
                    (req.requestList[u].addresses[0].promiseReject as Function)(this.lastError);
                }
            } else {
                const req = this.requestQueue[i].request as SendWriteRequest;
                (req.requestList[0].itemReference.address.promiseReject as Function)(this.lastError);
            }
        }
        this.requestQueue = [];
    }

    private stringToS7Addr(readOrWrite: 'read' | 'write', addr: string, useraddr?: string): Address {
        let errMessage: string = '';
        const address: Address = this.Address;
        if (useraddr === '_COMMERR') {
            address.valid = false;
            return address;
        } // Special-case for communication error status - this variable returns true when there is a communications error

        const splitString = addr.split(',');
        if (splitString.length === 0 || splitString.length > 2) {
            errMessage = 'Error - String Couldnt Split Properly.';
            this.lastError = errMessage;
            this.outputLog(errMessage);
            address.valid = false;
            return address;
        }

        if (splitString.length > 1) {
            // Must be DB type
            address.Type = 'DB'; // Hard code
            const splitString2 = splitString[1].split('.');
            address.dataType = splitString2[0].replace(/[0-9]/gi, '').toUpperCase(); // Clear the numbers
            if (address.dataType === 'X' && splitString2.length === 3) {
                address.arrayLength = parseInt(splitString2[2], 10);
            } else if ((address.dataType === 'S' || address.dataType === 'STRING') && splitString2.length === 3) {
                address.dataTypeLength = parseInt(splitString2[1], 10) + 2; // With strings, add 2 to the length due to S7 header
                address.arrayLength = parseInt(splitString2[2], 10); // For strings, array length is now the number of strings
            } else if ((address.dataType === 'S' || address.dataType === 'STRING') && splitString2.length === 2) {
                address.dataTypeLength = parseInt(splitString2[1], 10) + 2; // With strings, add 2 to the length due to S7 header
                address.arrayLength = 1;
            } else if (address.dataType !== 'X' && splitString2.length === 2) {
                address.arrayLength = parseInt(splitString2[1], 10);
            } else {
                address.arrayLength = 1;
            }
            if (address.arrayLength <= 0) {
                errMessage = 'Zero length arrays not allowed, returning undefined';
                this.lastError = errMessage;
                this.outputLog(errMessage);
                address.valid = false;
                return address;
            }

            // Get the data block number from the first part.
            address.dbNumber = parseInt(splitString[0].replace(/[A-z]/gi, ''), 10);

            // Get the data block byte offset from the second part, eliminating characters.
            // Note that at this point, we may miss some info, like a "T" at the end indicating TIME data type or DATE data type or DT data type.  We ignore these.
            // This is on the TODO list.
            address.offset = parseInt(splitString2[0].replace(/[A-z]/gi, ''), 10); // Get rid of characters

            // Get the bit offset
            if (splitString2.length > 1 && address.dataType === 'X') {
                address.bitOffset = parseInt(splitString2[1], 10);
                if (isNaN(address.bitOffset) || address.bitOffset < 0 || address.bitOffset > 7) {
                    errMessage = 'Invalid bit offset specified for address ' + addr;
                    this.lastError = errMessage;
                    this.outputLog(errMessage);
                    address.valid = false;
                    return address;
                }
            }
        } else {
            // Must not be DB.  We know there's no comma.
            const splitString2 = addr.split('.');

            switch (splitString2[0].replace(/[0-9]/gi, '')) {
                /* We do have the memory areas:
                  "input", "peripheral input", "output", "peripheral output", ",marker", "counter" and "timer" as I, PI, Q, PQ, M, C and T.
                   Datablocks are handles somewere else.
                   We do have the data types:
                   "bit", "byte", "char", "word", "int16", "dword", "int32", "real" as X, B, C, W, I, DW, DI and R
                   What about "uint16", "uint32"
                */

                /* All styles of peripheral IOs (no bit access allowed) */
                case 'PIB':
                case 'PEB':
                case 'PQB':
                case 'PAB':
                    address.Type = 'P';
                    address.dataType = 'BYTE';
                    break;
                case 'PIC':
                case 'PEC':
                case 'PQC':
                case 'PAC':
                    address.Type = 'P';
                    address.dataType = 'CHAR';
                    break;
                case 'PIW':
                case 'PEW':
                case 'PQW':
                case 'PAW':
                    address.Type = 'P';
                    address.dataType = 'WORD';
                    break;
                case 'PII':
                case 'PEI':
                case 'PQI':
                case 'PAI':
                    address.Type = 'P';
                    address.dataType = 'INT';
                    break;
                case 'PID':
                case 'PED':
                case 'PQD':
                case 'PAD':
                    address.Type = 'P';
                    address.dataType = 'DWORD';
                    break;
                case 'PIDI':
                case 'PEDI':
                case 'PQDI':
                case 'PADI':
                    address.Type = 'P';
                    address.dataType = 'DINT';
                    break;
                case 'PIR':
                case 'PER':
                case 'PQR':
                case 'PAR':
                    address.Type = 'P';
                    address.dataType = 'REAL';
                    break;

                /* All styles of standard inputs (in oposit to peripheral inputs) */
                case 'I':
                case 'E':
                    address.Type = 'I';
                    address.dataType = 'X';
                    break;
                case 'IB':
                case 'EB':
                    address.Type = 'I';
                    address.dataType = 'BYTE';
                    break;
                case 'IC':
                case 'EC':
                    address.Type = 'I';
                    address.dataType = 'CHAR';
                    break;
                case 'IW':
                case 'EW':
                    address.Type = 'I';
                    address.dataType = 'WORD';
                    break;
                case 'II':
                case 'EI':
                    address.Type = 'I';
                    address.dataType = 'INT';
                    break;
                case 'ID':
                case 'ED':
                    address.Type = 'I';
                    address.dataType = 'DWORD';
                    break;
                case 'IDI':
                case 'EDI':
                    address.Type = 'I';
                    address.dataType = 'DINT';
                    break;
                case 'IR':
                case 'ER':
                    address.Type = 'I';
                    address.dataType = 'REAL';
                    break;

                /* All styles of standard outputs (in oposit to peripheral outputs) */
                case 'Q':
                case 'A':
                    address.Type = 'Q';
                    address.dataType = 'X';
                    break;
                case 'QB':
                case 'AB':
                    address.Type = 'Q';
                    address.dataType = 'BYTE';
                    break;
                case 'QC':
                case 'AC':
                    address.Type = 'Q';
                    address.dataType = 'CHAR';
                    break;
                case 'QW':
                case 'AW':
                    address.Type = 'Q';
                    address.dataType = 'WORD';
                    break;
                case 'QI':
                case 'AI':
                    address.Type = 'Q';
                    address.dataType = 'INT';
                    break;
                case 'QD':
                case 'AD':
                    address.Type = 'Q';
                    address.dataType = 'DWORD';
                    break;
                case 'QDI':
                case 'ADI':
                    address.Type = 'Q';
                    address.dataType = 'DINT';
                    break;
                case 'QR':
                case 'AR':
                    address.Type = 'Q';
                    address.dataType = 'REAL';
                    break;

                /* All styles of marker */
                case 'M':
                    address.Type = 'M';
                    address.dataType = 'X';
                    break;
                case 'MB':
                    address.Type = 'M';
                    address.dataType = 'BYTE';
                    break;
                case 'MC':
                    address.Type = 'M';
                    address.dataType = 'CHAR';
                    break;
                case 'MW':
                    address.Type = 'M';
                    address.dataType = 'WORD';
                    break;
                case 'MI':
                    address.Type = 'M';
                    address.dataType = 'INT';
                    break;
                case 'MD':
                    address.Type = 'M';
                    address.dataType = 'DWORD';
                    break;
                case 'MDI':
                    address.Type = 'M';
                    address.dataType = 'DINT';
                    break;
                case 'MR':
                    address.Type = 'M';
                    address.dataType = 'REAL';
                    break;

                /* Timer */
                case 'T':
                    address.Type = 'T';
                    address.dataType = 'TIMER';
                    break;

                /* Counter */
                case 'C':
                    address.Type = 'C';
                    address.dataType = 'COUNTER';
                    break;

                default:
                    errMessage = 'Failed to find a match for ' + splitString2[0];
                    this.lastError = errMessage;
                    this.outputLog(errMessage);
                    address.valid = false;
                    return address;
            }

            address.bitOffset = 0;
            if (splitString2.length > 1 && address.dataType === 'X') {
                // Bit and bit array
                address.bitOffset = parseInt(splitString2[1].replace(/[A-z]/gi, ''), 10);
                if (splitString2.length > 2) {
                    // Bit array only
                    address.arrayLength = parseInt(splitString2[2].replace(/[A-z]/gi, ''), 10);
                } else {
                    address.arrayLength = 1;
                }
            } else if (splitString2.length > 1 && address.dataType !== 'X') {
                // Bit and bit array
                address.arrayLength = parseInt(splitString2[1].replace(/[A-z]/gi, ''), 10);
            } else {
                address.arrayLength = 1;
            }
            address.dbNumber = 0;
            address.offset = parseInt(splitString2[0].replace(/[A-z]/gi, ''), 10);
        }

        if (isNaN(address.offset) || address.offset < 0) {
            errMessage = 'Invalid byte offset specified for address ' + addr;
            this.lastError = errMessage;
            this.outputLog(errMessage);
            address.valid = false;
            return address;
        }

        if (address.dataType === 'DI') {
            address.dataType = 'DINT';
        }
        if (address.dataType === 'I') {
            address.dataType = 'INT';
        }
        if (address.dataType === 'DW') {
            address.dataType = 'DWORD';
        }
        if (address.dataType === 'R') {
            address.dataType = 'REAL';
        }

        switch (address.dataType) {
            case 'REAL':
            case 'DWORD':
            case 'DINT':
                address.dataTypeLength = 4;
                break;
            case 'INT':
            case 'WORD':
            case 'TIMER':
            case 'COUNTER':
                address.dataTypeLength = 2;
                break;
            case 'X':
            case 'B':
            case 'C':
            case 'BYTE':
            case 'CHAR':
                address.dataTypeLength = 1;
                break;
            case 'S':
            case 'STRING':
                // For strings, arrayLength and dtypelen were assigned during parsing.
                break;
            default:
                errMessage = 'Unknown data type ' + address.dataType;
                this.lastError = errMessage;
                this.outputLog(errMessage);
                address.valid = false;
                return address;
        }

        // Default
        address.transportCode = 0x04;

        switch (address.Type) {
            case 'DB':
            case 'DI':
                address.areaS7Code = 0x84;
                break;
            case 'I':
            case 'E':
                address.areaS7Code = 0x81;
                break;
            case 'Q':
            case 'A':
                address.areaS7Code = 0x82;
                break;
            case 'M':
                address.areaS7Code = 0x83;
                break;
            case 'P':
                address.areaS7Code = 0x80;
                break;
            case 'C':
                address.areaS7Code = 0x1c;
                address.transportCode = 0x09;
                break;
            case 'T':
                address.areaS7Code = 0x1d;
                address.transportCode = 0x09;
                break;
            default:
                errMessage = 'Unknown memory area entered - ' + address.dataType;
                this.lastError = errMessage;
                this.outputLog(errMessage);
                address.valid = false;
                return address;
        }

        if (address.dataType === 'X' && address.arrayLength === 1 && readOrWrite === 'write') {
            address.transportCode = 0x03;
        }
        // Save the address from the argument for later use and reference
        address.name = addr;
        if (useraddr === undefined) {
            address.userName = addr;
        } else {
            address.userName = useraddr;
        }

        if (address.dataType === 'X') {
            address.byteLength = Math.ceil((address.bitOffset + address.arrayLength) / 8);
        } else {
            if (address.arrayLength === 0) {
                errMessage = 'Array length cannot be 0: ' + address.name;
                this.lastError = errMessage;
                this.outputLog(errMessage);
                address.valid = false;
                return address;
            }
            address.byteLength = address.arrayLength * address.dataTypeLength;
        }

        //	outputLog(' Arr lenght is ' + address.arrayLength + ' and DTL is ' + address.dtypelen);

        address.byteLengthWithFill = address.byteLength;
        if (address.byteLengthWithFill % 2) {
            address.byteLengthWithFill += 1;
        } // S7 will add a filler byte.  Use this expected reply length for PDU calculations.
        return address;
    }

    private stringArrayToS7AddressArray(items: string | string[], operation: 'write' | 'read'): Promise<Address[]> {
        return new Promise<Address[]>((resolve, reject): void => {
            this.outputLog('Adding ' + items, 0, this.connectionId);
            const addresses: Address[] = [];
            if (typeof items === 'string' && items !== '_COMMERR') {
                let address = this.Address;
                address = this.stringToS7Addr(operation, this.translationCB(items), items);
                addresses.push(address);
            } else if (Array.isArray(items)) {
                for (let i = 0; i < items.length; i++) {
                    if (typeof items[i] === 'string' && items[i] !== '_COMMERR') {
                        let address = this.Address;
                        address = this.stringToS7Addr(operation, this.translationCB(items[i]), items[i]);
                        addresses.push(address);
                    }
                }
            }

            // Validity check.
            for (let i = 0; i < addresses.length; i++) {
                if (!addresses[i].valid) {
                    addresses.splice(i, 1);
                    // this.outputLog('Dropping an undefined request item.', 0, this.connectionId);
                    reject(new Error(this.lastError));
                }
            }
            resolve(addresses);
        });
    }

    private S7AddrToBuffer(address: Address, totalByteLength: number, totalByteLengthWithFill: number, totalOffset: number, isWriting: boolean): Buffer {
        let thisBitOffset = 0;
        const theReq = Buffer.from([0x12, 0x0a, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

        // First 3 bytes (0,1,2) is constant, sniffed from other traffic, for S7 head.
        // Next one is "byte length" - we always request X number of bytes - even for a REAL with length of 1 we read BYTES length of 4.
        theReq[3] = 0x02; // Byte length
        // Next we write the number of bytes we are going to read.

        if (address.dataType === 'X') {
            theReq.writeUInt16BE(totalByteLength, 4);
            if (isWriting && address.arrayLength === 1) {
                // Byte length will be 1 already so no need to special case this.
                theReq[3] = 0x01; // 1 = "BIT" length
                // We need to specify the bit offset in this case only.  Normally, when reading, we read the whole byte anyway and shift bits around.  Can't do this when writing only one bit.
                thisBitOffset = address.bitOffset;
            }
        } else if (address.Type === 'TIMER' || address.Type === 'COUNTER') {
            theReq.writeUInt16BE(1, 4);
            theReq.writeUInt8(address.areaS7Code, 3);
        } else {
            theReq.writeUInt16BE(totalByteLength, 4);
        }
        // Then we write the data block number.
        theReq.writeUInt16BE(address.dbNumber, 6);

        // Write our area crossing pointer.  When reading, write a bit offset of 0 - we shift the bit offset out later only when reading.
        theReq.writeUInt32BE(totalOffset * 8 + thisBitOffset, 8);

        // Now we have to BITWISE OR the area code over the area crossing pointer.
        // This must be done AFTER writing the area crossing pointer as there is overlap, but this will only be noticed on large DB.
        theReq[8] |= address.areaS7Code;
        return theReq;
    }

    private getWriteBuffer(s7Item: S7ItemWrite): Buffer {
        let newBuffer: Buffer;

        // NOTE: It seems that when writing, the data that is sent must have a "fill byte" so that data length is even only for all
        //  but the last request.  The last request must have no padding.  So we DO NOT add the padding here anymore.

        if (s7Item.address.dataType === 'X' && s7Item.address.arrayLength === 1) {
            newBuffer = Buffer.alloc(2 + 3); // Changed from 2 + 4 to 2 + 3 as padding was moved out of this function
            // Initialize, especially be sure to get last bit which may be a fill bit.
            newBuffer.writeUInt16BE(1, 2); // Might need to do something different for different trans codes
        } else {
            newBuffer = Buffer.alloc(s7Item.address.byteLength + 4);
            newBuffer.writeUInt16BE(s7Item.address.byteLength * 8, 2); // Might need to do something different for different trans codes
        }

        if (s7Item.writeBuffer.length < s7Item.address.byteLengthWithFill) {
            this.outputLog("Attempted to access part of the write buffer that wasn't there when writing an item.");
        }

        newBuffer[0] = 0;
        newBuffer[1] = s7Item.address.transportCode;

        s7Item.writeBuffer.copy(newBuffer, 4, 0, s7Item.address.byteLength); // Not with fill.  It might not be that long.
        return newBuffer;
    }

    private bufferizeValue(address: Address, writeValue: (string | number | boolean) | (string | number | boolean)[]): Buffer {
        const writeBuffer = Buffer.alloc(8192);
        let thePointer, theByte;
        theByte = 0;
        thePointer = 0; // After length and header
        if (address.arrayLength > 1) {
            // Array value.
            let bitShiftAmount = address.bitOffset;

            for (let arrayIndex = 0; arrayIndex < address.arrayLength; arrayIndex++) {
                switch (address.dataType) {
                    case 'REAL':
                        writeBuffer.writeFloatBE((writeValue as number[])[arrayIndex], thePointer);
                        break;
                    case 'DWORD':
                        writeBuffer.writeInt32BE((writeValue as number[])[arrayIndex], thePointer);
                        break;
                    case 'DINT':
                        writeBuffer.writeInt32BE((writeValue as number[])[arrayIndex], thePointer);
                        break;
                    case 'INT':
                        writeBuffer.writeInt16BE((writeValue as number[])[arrayIndex], thePointer);
                        break;
                    case 'WORD':
                        writeBuffer.writeUInt16BE((writeValue as number[])[arrayIndex], thePointer);
                        break;
                    case 'X':
                        theByte = theByte | (((writeValue as boolean[])[arrayIndex] === true ? 1 : 0) << bitShiftAmount);
                        // Maybe not so efficient to do this every time when we only need to do it every 8.  Need to be careful with optimizations here for odd requests.
                        writeBuffer.writeUInt8(theByte, thePointer);
                        bitShiftAmount++;
                        break;
                    case 'B':
                    case 'BYTE':
                        writeBuffer.writeUInt8((writeValue as number[])[arrayIndex], thePointer);
                        break;
                    case 'C':
                    case 'CHAR':
                        // Convert to string.
                        writeBuffer.writeUInt8((writeValue as string).charCodeAt(arrayIndex), thePointer);
                        break;
                    case 'S':
                    case 'STRING':
                        // Convert to bytes.
                        writeBuffer.writeUInt8(address.dataTypeLength - 2, thePointer); // Array length is requested val, -2 is string length
                        writeBuffer.writeUInt8(Math.min(address.dataTypeLength - 2, (writeValue as string[])[arrayIndex].length), thePointer + 1); // Array length is requested val, -2 is string length
                        for (let charOffset = 2; charOffset < address.dataTypeLength; charOffset++) {
                            if (charOffset < (writeValue as string[])[arrayIndex].length + 2) {
                                writeBuffer.writeUInt8((writeValue as string[])[arrayIndex].charCodeAt(charOffset - 2), thePointer + charOffset);
                            } else {
                                writeBuffer.writeUInt8(32, thePointer + charOffset); // write space
                            }
                        }
                        break;
                    case 'TIMER':
                    case 'COUNTER':
                        // I didn't think we supported arrays of timers and counters.
                        writeBuffer.writeInt16BE((writeValue as number[])[arrayIndex], thePointer);
                        break;
                    default:
                        this.outputLog('Unknown data type when preparing array write packet - should never happen.  Should have been caught earlier.  ' + address.dataType);
                }
                if (address.dataType == 'X') {
                    // For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset.
                    // Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to
                    // drop support for this at the request level or support it here.
                    if ((arrayIndex + address.bitOffset + 1) % 8 === 0 || arrayIndex == address.arrayLength - 1) {
                        thePointer += address.dataTypeLength;
                        bitShiftAmount = 0;
                        // Zero this now.  Otherwise it will have the same value next byte if non-zero.
                        theByte = 0;
                    }
                } else {
                    // Add to the pointer every time.
                    thePointer += address.dataTypeLength;
                }
            }
        } else {
            // Single value.
            switch (address.dataType) {
                case 'REAL':
                    writeBuffer.writeFloatBE(writeValue as number, thePointer);
                    break;
                case 'DWORD':
                    writeBuffer.writeUInt32BE(writeValue as number, thePointer);
                    break;
                case 'DINT':
                    writeBuffer.writeInt32BE(writeValue as number, thePointer);
                    break;
                case 'INT':
                    writeBuffer.writeInt16BE(writeValue as number, thePointer);
                    break;
                case 'WORD':
                    writeBuffer.writeUInt16BE(writeValue as number, thePointer);
                    break;
                case 'X':
                    writeBuffer.writeUInt8((writeValue as boolean) === true ? 1 : 0, thePointer);
                    break;
                case 'B':
                case 'BYTE':
                    // No support as of yet for signed 8 bit.  This isn't that common in Siemens.
                    writeBuffer.writeUInt8(writeValue as number, thePointer);
                    break;
                case 'C':
                case 'CHAR':
                    // No support as of yet for signed 8 bit.  This isn't that common in Siemens.
                    writeBuffer.writeUInt8((writeValue as string).charCodeAt(0), thePointer);
                    break;
                case 'S':
                case 'STRING':
                    // Convert to bytes.
                    writeBuffer.writeUInt8(address.dataTypeLength - 2, thePointer); // Array length is requested val, -2 is string length
                    writeBuffer.writeUInt8(Math.min(address.dataTypeLength - 2, (writeValue as string).length), thePointer + 1); // Array length is requested val, -2 is string length

                    for (let charOffset = 2; charOffset < address.dataTypeLength; charOffset++) {
                        if (charOffset < (writeValue as string).length + 2) {
                            writeBuffer.writeUInt8((writeValue as string).charCodeAt(charOffset - 2), thePointer + charOffset);
                        } else {
                            writeBuffer.writeUInt8(32, thePointer + charOffset); // write space
                        }
                    }
                    break;
                case 'TIMER':
                case 'COUNTER':
                    writeBuffer.writeInt16BE(writeValue as number, thePointer);
                    break;
                default:
                    this.outputLog('Unknown data type in write prepare - should never happen.  Should have been caught earlier.  ' + address.dataType);
            }
            thePointer += address.dataTypeLength;
        }
        return writeBuffer;
    }

    private addressListSorter(a: Address, b: Address): number {
        // Feel free to manipulate these next two lines...
        if (a.areaS7Code < b.areaS7Code) {
            return -1;
        }
        if (a.areaS7Code > b.areaS7Code) {
            return 1;
        }

        // Group first the items of the same DB
        if (a.Type === 'DB') {
            if (a.dbNumber < b.dbNumber) {
                return -1;
            }
            if (a.dbNumber > b.dbNumber) {
                return 1;
            }
        }

        // But for byte offset we need to start at 0.
        if (a.offset < b.offset) {
            return -1;
        }
        if (a.offset > b.offset) {
            return 1;
        }

        // Then bit offset
        if (a.bitOffset < b.bitOffset) {
            return -1;
        }
        if (a.bitOffset > b.bitOffset) {
            return 1;
        }

        // Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
        if (a.byteLength > b.byteLength) {
            return -1;
        }
        if (a.byteLength < b.byteLength) {
            return 1;
        }
        return 0;
    }

    private itemListSorter(a: S7ItemWrite, b: S7ItemWrite): number {
        // Feel free to manipulate these next two lines...
        if (a.address.areaS7Code < b.address.areaS7Code) {
            return -1;
        }
        if (a.address.areaS7Code > b.address.areaS7Code) {
            return 1;
        }

        // Group first the items of the same DB
        if (a.address.Type === 'DB') {
            if (a.address.dbNumber < b.address.dbNumber) {
                return -1;
            }
            if (a.address.dbNumber > b.address.dbNumber) {
                return 1;
            }
        }

        // But for byte offset we need to start at 0.
        if (a.address.offset < b.address.offset) {
            return -1;
        }
        if (a.address.offset > b.address.offset) {
            return 1;
        }

        // Then bit offset
        if (a.address.bitOffset < b.address.bitOffset) {
            return -1;
        }
        if (a.address.bitOffset > b.address.bitOffset) {
            return 1;
        }

        // Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
        if (a.address.byteLength > b.address.byteLength) {
            return -1;
        }
        if (a.address.byteLength < b.address.byteLength) {
            return 1;
        }
        return 0;
    }

    private isOptimizableArea(area: number): boolean {
        if (this.doNotOptimize) {
            return false;
        } // Are we skipping all optimization due to user request
        switch (area) {
            case 0x84: // db
            case 0x81: // input bytes
            case 0x82: // output bytes
            case 0x83: // memory bytes
                return true;
            default:
                return false;
        }
    }

    public isWaiting(): boolean {
        if (this.requestQueue.length || this.sentReadPacketArray.length || this.sentWritePacketArray.length) {
            return true;
        } else {
            return false;
        }
    }

    private packetTimeout(packetType: PacketTimeout, packetSeqNum?: number): void {
        this.outputLog('PacketTimeout called with type ' + packetType + ' and seq ' + packetSeqNum, 1, this.connectionId);
        if (packetType === 'ISO') {
            this.outputLog('TIMED OUT connecting to the PLC - Disconnecting', 0, this.connectionId);
            this.outputLog('Wait for 2 seconds then try again.', 0, this.connectionId);
            this.outputLog('Scheduling a reconnect from packetTimeout, connect type', 0, this.connectionId);
            clearTimeout(this.reconnectTimer);
            const timeHandler: TimerHandler = (): void => {
                this.outputLog('The scheduled reconnect from packetTimeout, connect type, is happening now', 0, this.connectionId);
                this.connectionReset();
            };
            this.reconnectTimer = setTimeout(timeHandler, 2000);
            return;
        }
        if (packetType === 'PDU') {
            this.outputLog('TIMED OUT waiting for PDU reply packet from PLC - Disconnecting');
            this.outputLog('Wait for 2 seconds then try again.', 0, this.connectionId);
            this.outputLog('Scheduling a reconnect from packetTimeout, connect type', 0, this.connectionId);
            clearTimeout(this.reconnectTimer);
            const timeHandler: TimerHandler = (): void => {
                this.outputLog('The scheduled reconnect from packetTimeout, PDU type, is happening now', 0, this.connectionId);
                this.connectionReset();
            };
            this.reconnectTimer = setTimeout(timeHandler, 2000);
            return;
        }
        if (packetType === 'read') {
            this.outputLog('READ TIMEOUT on sequence number ' + packetSeqNum, 0, this.connectionId);
            this.isoConnectionState = 'disconnected';
            this.rejectAllRequestQueue();
            if (typeof packetSeqNum !== 'undefined') {
                this.readResponse(undefined, this.findReadIndexOfSeqNum(packetSeqNum) as number);
            }
            return;
        }
        if (packetType === 'write') {
            this.isoConnectionState = 'disconnected';
            this.rejectAllRequestQueue();
            this.outputLog('WRITE TIMEOUT on sequence number ' + packetSeqNum, 0, this.connectionId);
            if (typeof packetSeqNum !== 'undefined') {
                this.writeResponse(undefined, this.findWriteIndexOfSeqNum(packetSeqNum) as number);
            }
            return;
        }
        this.outputLog("Unknown timeout error.  Nothing was done - this shouldn't happen.");
        this.lastError = "Unknown timeout error.  Nothing was done - this shouldn't happen.";
    }

    private connectionReset(): void {
        this.isoConnectionState = 'disconnected';
        if (this.client) {
            this.client.destroy();
        }
        if (!this.isWaiting()) {
            this.connectNow();
        }
    }

    private connectError(err: Error): void {
        // Note that the first time we are connecting we call the connectCallback, then after that, we reconnect again on a connection error
        this.isoConnectionState = 'disconnected';
        this.outputLog('We Caught a connect error: ' + err.message, 0, this.connectionId);
        this.connectionReset();
    }

    private readWriteError(err: Error): void {
        this.outputLog('We Caught a read/write error ' + err.message + ' - will CLOSE the connection');
        this.isoConnectionState = 'disconnected';
    }

    private connectionCleanup(): void {
        this.outputLog('Connection cleanup is happening');
        if (typeof this.client !== 'undefined') {
            // destroying the socket connection
            this.client.destroy();
            this.client.removeAllListeners('data');
            this.client.removeAllListeners('error');
            this.client.removeAllListeners('close');
            this.client.on('error', (): void => {
                this.outputLog('TCP socket error following connection cleanup');
            });
        }
        clearTimeout(this.connectTimeout);
        clearTimeout(this.PDUTimeout);
    }

    private findReadIndexOfSeqNum(seqNum: number): number | undefined {
        for (let packetCounter = 0; packetCounter < this.sentReadPacketArray.length; packetCounter++) {
            if (this.sentReadPacketArray[packetCounter].seqNum == seqNum) {
                return packetCounter;
            }
        }
        return undefined;
    }

    private findWriteIndexOfSeqNum(seqNum: number): number | undefined {
        for (let packetCounter = 0; packetCounter < this.sentWritePacketArray.length; packetCounter++) {
            if (this.sentWritePacketArray[packetCounter].seqNum == seqNum) {
                return packetCounter;
            }
        }
        return undefined;
    }

    private validateWriteResponse(theData: Buffer | undefined, theItem: S7ItemWrite, thePointer: number): number {
        let errMessage: string = '';

        if (!theData) {
            errMessage = 'Timeout write error.';
            this.lastError = errMessage;
            this.outputLog(theItem.errCode);
            theItem.validResponseBuffer = false;
            return 0;
        }

        const remainingLength = theData.length - thePointer; // Say if length is 39 and pointer is 35 we can access 35,36,37,38 = 4 bytes.

        if (remainingLength < 1) {
            theItem.validResponseBuffer = false;
            errMessage = 'Malformed Packet - Less Than 1 Byte.';
            this.lastError = errMessage;
            this.outputLog(errMessage);
            return 0; // Hard to increment the pointer so we call it a malformed packet and we're done.
        }

        const writeResponse = theData.readUInt8(thePointer);
        theItem.writeResponse = writeResponse;

        if (writeResponse !== 0xff) {
            errMessage = 'Received write error of ' + theItem.writeResponse + ' on ' + theItem.address.name;
            this.outputLog(errMessage);
            this.lastError = errMessage;
            theItem.validResponseBuffer = false;
        } else {
            theItem.validResponseBuffer = true;
        }
        return thePointer + 1;
    }

    private validateReadResponse(theData: Buffer | undefined, request: ReadBlock, thePointer: number): { thePointer: number; bufferResponse: Buffer | undefined } {
        let remainingLength;
        let errMessage: string | undefined = undefined;

        if (typeof theData === 'undefined') {
            remainingLength = 0;
            this.outputLog('Processing an undefined packet, likely due to timeout error');
        } else {
            remainingLength = theData.length - thePointer; // Say if length is 39 and pointer is 35 we can access 35,36,37,38 = 4 bytes.
        }

        const prePointer = thePointer;
        if (remainingLength < 4) {
            if (typeof theData !== 'undefined') {
                errMessage = 'Malformed Packet - Less Than 4 Bytes.';
            } else {
                errMessage = 'Timeout error - zero length packet';
            }
            this.lastError = errMessage;
            this.outputLog(errMessage);
            return { thePointer: 0, bufferResponse: undefined };
        }

        let reportedDataLength;

        if (request.addresses[0].transportCode === 0x04) {
            reportedDataLength = (theData as Buffer).readUInt16BE(thePointer + 2) / 8; // For different transport codes this may not be right.
        } else {
            reportedDataLength = (theData as Buffer).readUInt16BE(thePointer + 2);
        }
        const responseCode = (theData as Buffer)[thePointer];
        const transportCode = (theData as Buffer)[thePointer + 1];

        if (remainingLength == reportedDataLength + 2) {
            this.outputLog('Not last part.');
        }
        if (remainingLength < reportedDataLength + 2) {
            errMessage = 'Malformed Packet - Item Data Length and Packet Length Disagree.  RDL+2 ' + (reportedDataLength + 2) + ' remainingLength ' + remainingLength;
            this.outputLog(errMessage);
            this.lastError = errMessage;
            return { thePointer: 0, bufferResponse: undefined };
        }

        if (responseCode !== 0xff) {
            errMessage = 'Invalid Response Code - ' + responseCode;
            this.outputLog(errMessage);
            this.lastError = errMessage;
            return { thePointer: thePointer + reportedDataLength + 4, bufferResponse: undefined };
        }

        if (transportCode !== request.addresses[0].transportCode) {
            errMessage = 'Invalid Transport Code - ' + transportCode;
            this.outputLog(errMessage);
            this.lastError = errMessage;
            return { thePointer: thePointer + reportedDataLength + 4, bufferResponse: undefined };
        }

        const expectedLength = request.totalbyteLength;

        if (reportedDataLength !== expectedLength) {
            errMessage = 'Invalid Response Length - Expected ' + expectedLength + ' but got ' + reportedDataLength + ' bytes.';
            this.outputLog(errMessage);
            this.lastError = errMessage;
            return { thePointer: reportedDataLength + 2, bufferResponse: undefined };
        }

        // Looks good so far.
        // Increment our data pointer past the status code, transport code and 2 byte length.
        thePointer += 4;

        const bufferResponse = (theData as Buffer).slice(thePointer, thePointer + reportedDataLength);
        // (theData as Buffer).slice(thePointer, thePointer + reportedDataLength).copy(theItem.byteBuffer, 0);

        // theItem.qualityBuffer.fill(0xc0); // Fill with 0xC0 (192) which means GOOD QUALITY in the OPC world.
        thePointer += request.totalbyteLength; //WithFill;

        if ((thePointer - prePointer) % 2) {
            // Odd number.  With the S7 protocol we only request an even number of bytes.  So there will be a filler byte.
            thePointer += 1;
        }

        return { thePointer, bufferResponse };
    }

    private BufferToAddressValue(address: Address, buffer: Buffer): string | number | boolean | undefined | (string | number | boolean)[] {
        let thePointer: number = 0;
        let strlen: number = 0;
        let tempString: string = '';
        let readValue: string | number | boolean | undefined | (string | number | boolean)[];
        let quality;
        if (address.arrayLength > 1) {
            // Array value.
            if (address.dataType != 'C' && address.dataType != 'CHAR') {
                readValue = [];
                quality = [];
            } else {
                readValue = '';
                quality = '';
            }
            let bitShiftAmount = address.bitOffset;
            for (let arrayIndex = 0; arrayIndex < address.arrayLength; arrayIndex++) {
                // If we're a string, quality is not an array.
                if (quality instanceof Array) {
                    quality.push('OK');
                } else {
                    quality = 'OK';
                }
                switch (address.dataType) {
                    case 'REAL':
                        (readValue as number[]).push(buffer.readFloatBE(thePointer));
                        break;
                    case 'DWORD':
                        (readValue as number[]).push(buffer.readUInt32BE(thePointer));
                        break;
                    case 'DINT':
                        (readValue as number[]).push(buffer.readInt32BE(thePointer));
                        break;
                    case 'INT':
                        (readValue as number[]).push(buffer.readInt16BE(thePointer));
                        break;
                    case 'WORD':
                        (readValue as number[]).push(buffer.readUInt16BE(thePointer));
                        break;
                    case 'X':
                        (readValue as boolean[]).push((buffer.readUInt8(thePointer) >> bitShiftAmount) & 1 ? true : false);
                        break;
                    case 'B':
                    case 'BYTE':
                        (readValue as number[]).push(buffer.readUInt8(thePointer));
                        break;
                    case 'S':
                    case 'STRING':
                        strlen = buffer.readUInt8(thePointer + 1);
                        tempString = '';
                        for (let charOffset = 2; charOffset < address.dataTypeLength && charOffset - 2 < strlen; charOffset++) {
                            // say strlen = 1 (one-char string) this char is at arrayIndex of 2.
                            // Convert to string.
                            tempString += String.fromCharCode(buffer.readUInt8(thePointer + charOffset));
                        }
                        (readValue as string[]).push(tempString);
                        break;
                    case 'C':
                    case 'CHAR':
                        // Convert to string.
                        (readValue as string) += String.fromCharCode(buffer.readUInt8(thePointer));
                        break;
                    case 'TIMER':
                    case 'COUNTER':
                        (readValue as number[]).push(buffer.readInt16BE(thePointer));
                        break;

                    default:
                        this.outputLog('Unknown data type in response - should never happen.  Should have been caught earlier.  ' + address.dataType);
                        return 0;
                }

                if (address.dataType == 'X') {
                    // For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset.
                    // Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to
                    // drop support for this at the request level or support it here.
                    bitShiftAmount++;
                    if ((arrayIndex + address.bitOffset + 1) % 8 === 0 || arrayIndex == address.arrayLength - 1) {
                        thePointer += address.dataTypeLength;
                        bitShiftAmount = 0;
                    }
                } else {
                    // Add to the pointer every time.
                    thePointer += address.dataTypeLength;
                }
            }
        } else {
            // Single value.
            if (!address.valid) {
                // theItem.readValue = theItem.badValue();
                // theItem.quality = 'BAD ' + theItem.qualityBuffer[thePointer];
            } else {
                quality = 'OK';
                switch (address.dataType) {
                    case 'REAL':
                        readValue = buffer.readFloatBE(thePointer);
                        break;
                    case 'DWORD':
                        readValue = buffer.readUInt32BE(thePointer);
                        break;
                    case 'DINT':
                        readValue = buffer.readInt32BE(thePointer);
                        break;
                    case 'INT':
                        readValue = buffer.readInt16BE(thePointer);
                        break;
                    case 'WORD':
                        readValue = buffer.readUInt16BE(thePointer);
                        break;
                    case 'X':
                        readValue = (buffer.readUInt8(thePointer) >> address.bitOffset) & 1 ? true : false;
                        break;
                    case 'B':
                    case 'BYTE':
                        // No support as of yet for signed 8 bit.  This isn't that common in Siemens.
                        readValue = buffer.readUInt8(thePointer);
                        break;
                    case 'S':
                    case 'STRING':
                        strlen = buffer.readUInt8(thePointer + 1);
                        readValue = '';
                        // evitar desbordamineto
                        for (let charOffset = 2; charOffset < address.dataTypeLength && charOffset - 2 < strlen; charOffset++) {
                            // say strlen = 1 (one-char string) this char is at arrayIndex of 2.
                            // Convert to string.

                            readValue += String.fromCharCode(buffer.readUInt8(thePointer + charOffset));
                        }
                        break;
                    case 'C':
                    case 'CHAR':
                        // No support as of yet for signed 8 bit.  This isn't that common in Siemens.
                        readValue = String.fromCharCode(buffer.readUInt8(thePointer));
                        break;
                    case 'TIMER':
                    case 'COUNTER':
                        readValue = buffer.readInt16BE(thePointer);
                        break;
                    default:
                        this.outputLog('Unknown data type in response - should never happen.  Should have been caught earlier.  ' + address.dataType);
                        return 0;
                }
            }
            thePointer += address.dataTypeLength;
        }

        if (thePointer % 2) {
            // Odd number.  With the S7 protocol we only request an even number of bytes.  So there will be a filler byte.
            thePointer += 1;
        }

        //	outputLog("We have an item value of " + theItem.value + " for " + theItem.addr + " and pointer of " + thePointer);
        return readValue;
    }

    private checkReadResponseParts(readRequestSequence: number): boolean {
        for (let i = 0; i < this.sentReadPacketArray.length; i++) {
            if (this.sentReadPacketArray[i].readRequestSequence === readRequestSequence) {
                if (this.sentReadPacketArray[i].rcvd === false) {
                    return false;
                }
            }
        }
        return true;
    }

    private checkWriteResponseParts(writeRequestSequence: number): boolean {
        for (let i = 0; i < this.sentWritePacketArray.length; i++) {
            if (this.sentWritePacketArray[i].writeRequestSequence === writeRequestSequence) {
                if (this.sentWritePacketArray[i].rcvd === false) {
                    return false;
                }
            }
        }
        return true;
    }

    private readResponse(data: Buffer | undefined, foundSeqIndex: number): void {
        this.outputLog('Read response called', 1, this.connectionId);

        // Make a note of the time it took the PLC to process the request.
        this.outputLog('Received in ' + (process.hrtime.bigint() - this.sentReadPacketArray[foundSeqIndex].reqTime) + ' nanoseconds', 0, this.connectionId);

        clearTimeout(this.sentReadPacketArray[foundSeqIndex].timeout);

        if (!this.sentReadPacketArray[foundSeqIndex].sent) {
            this.outputLog('WARNING: Received a read response packet that was not marked as sent', 0, this.connectionId);
            return;
        }

        if (this.sentReadPacketArray[foundSeqIndex].rcvd) {
            this.outputLog('WARNING: Received a read response packet that was already marked as received', 0, this.connectionId);
            return;
        }

        this.sentReadPacketArray[foundSeqIndex].rcvd = true;
        this.parallelJobsNow -= 1;
        if (this.requestQueue.length) {
            this.sendNextRequest();
        }
        let dataPointer = 21; // For non-routed packets we start at byte 21 of the packet.  If we do routing it will be more than this.

        for (let i = 0; i < this.sentReadPacketArray[foundSeqIndex].requestList.length; i++) {
            const { thePointer, bufferResponse } = this.validateReadResponse(data, this.sentReadPacketArray[foundSeqIndex].requestList[i], dataPointer);
            dataPointer = thePointer;
            this.sentReadPacketArray[foundSeqIndex].requestList[i].responseBuffer = bufferResponse;
            if (!dataPointer) {
                this.outputLog('Received a ZERO RESPONSE Processing Read Packet due to unrecoverable packet error', 0, this.connectionId);
                break;
            }
        }
        let canDeletePackets: boolean = true;
        // If the sentReadPacket have only one part, we can continue to check values
        if (this.sentReadPacketArray[foundSeqIndex].requestList[0].parts === 1) {
            for (let i = 0; i < this.sentReadPacketArray[foundSeqIndex].requestList.length; i++) {
                if (typeof this.sentReadPacketArray[foundSeqIndex].requestList[i].responseBuffer !== 'undefined') {
                    let offset = 0;
                    const buffer: Buffer = (this.sentReadPacketArray[foundSeqIndex].requestList[i].responseBuffer as Buffer).slice(offset, this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[0].byteLength + offset);
                    const value = this.BufferToAddressValue(this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[0], buffer);
                    this.outputLog('Address ' + this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[0].userName + ' has value ' + value, 1, this.connectionId);

                    const result: { [key: string]: any } = {};
                    result[this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[0].userName] = value;
                    (this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[0].promiseResolve as Function)(result);

                    for (let u = 1; u < this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses.length; u++) {
                        const pastOffset = this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u - 1].offset;
                        const currentOffset = this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u].offset;
                        if (pastOffset !== currentOffset) {
                            offset += this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u].offset - this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u - 1].offset;
                        } else {
                            offset = offset;
                        }

                        const buffer: Buffer = (this.sentReadPacketArray[foundSeqIndex].requestList[i].responseBuffer as Buffer).slice(offset, this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u].byteLength + offset);

                        const value = this.BufferToAddressValue(this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u], buffer);
                        this.outputLog('Address ' + this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u].userName + ' has value ' + value, 1, this.connectionId);

                        const result: { [key: string]: any } = {};
                        result[this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u].userName] = value;
                        (this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[u].promiseResolve as Function)(result);
                    }
                } else {
                    for (let u = 0; u < this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses.length; u++) {
                        (this.sentReadPacketArray[foundSeqIndex].requestList[i].addresses[0].promiseReject as Function)(this.lastError);
                    }
                }
            }
        } else if (this.sentReadPacketArray[foundSeqIndex].requestList[0].parts > 1 && this.checkReadResponseParts(this.sentReadPacketArray[foundSeqIndex].readRequestSequence as number)) {
            // If the sentReadPacket have two or more parts and are already received
            let validResponse: boolean = true;
            const buffer: Buffer = Buffer.alloc(this.sentReadPacketArray[foundSeqIndex].requestList[0].addresses[0].dataTypeLength);
            const readRequestSequence = this.sentReadPacketArray[foundSeqIndex].requestList[0].readRequestSequence;
            for (let i = 0; i < this.sentReadPacketArray.length; i++) {
                if (this.sentReadPacketArray[i].readRequestSequence === readRequestSequence) {
                    if (typeof this.sentReadPacketArray[i].requestList[0].responseBuffer !== 'undefined') {
                        (this.sentReadPacketArray[i].requestList[0].responseBuffer as Buffer).copy(buffer, this.sentReadPacketArray[i].requestList[0].offset - this.sentReadPacketArray[i].requestList[0].addresses[0].offset);
                    } else {
                        validResponse = false;
                    }
                }
            }

            if (validResponse) {
                const value = this.BufferToAddressValue(this.sentReadPacketArray[foundSeqIndex].requestList[0].addresses[0], buffer);
                this.outputLog('Address ' + this.sentReadPacketArray[foundSeqIndex].requestList[0].addresses[0].userName + ' has value ' + value, 1, this.connectionId);

                const result: { [key: string]: any } = {};
                result[this.sentReadPacketArray[foundSeqIndex].requestList[0].addresses[0].userName] = value;

                (this.sentReadPacketArray[foundSeqIndex].requestList[0].addresses[0].promiseResolve as Function)(result);
            } else {
                (this.sentReadPacketArray[foundSeqIndex].requestList[0].addresses[0].promiseReject as Function)();
            }
        } else {
            // we must wait until other parts comming for check
            this.outputLog('Wait for parts of read request part' + this.sentReadPacketArray[foundSeqIndex].readRequestSequence, 1, this.connectionId);
            canDeletePackets = false;
        }

        if (canDeletePackets) {
            this.sentReadPacketArray = this.sentReadPacketArray.filter((packet): boolean => {
                return packet.readRequestSequence !== this.sentReadPacketArray[foundSeqIndex].readRequestSequence;
            });
        }

        // If a response was whit timeout exceeded, the connectionState change to 'disconnected'
        if (this.isoConnectionState === 'disconnected') {
            // Reject all pending requests
            this.rejectAllRequestQueue();
            // reconnect
            this.connectionReset();
        }
    }

    private writeResponse(data: Buffer | undefined, foundSeqIndex: number): void {
        this.outputLog('Write response called', 1, this.connectionId);

        // Make a note of the time it took the PLC to process the request.
        this.outputLog('Received in ' + (process.hrtime.bigint() - this.sentWritePacketArray[foundSeqIndex].reqTime) + ' nanoseconds', 0, this.connectionId);

        clearTimeout(this.sentWritePacketArray[foundSeqIndex].timeout);

        this.sentWritePacketArray[foundSeqIndex].rcvd = true;
        this.parallelJobsNow -= 1;
        if (this.requestQueue.length) {
            this.sendNextRequest();
        }

        let dataPointer = 21;

        for (let itemCount = 0; itemCount < this.sentWritePacketArray[foundSeqIndex].requestList.length; itemCount++) {
            dataPointer = this.validateWriteResponse(data, this.sentWritePacketArray[foundSeqIndex].requestList[itemCount].itemReference, dataPointer);
            if (!dataPointer) {
                this.outputLog('Stopping Processing Write Response Packet due to unrecoverable packet error');
                break;
            }
        }

        let canDeletePackets: boolean = true;

        // If the sentReadPacket have only one part, we can continue to check values
        if (this.sentWritePacketArray[foundSeqIndex].requestList[0].parts === 1) {
            for (let i = 0; i < this.sentWritePacketArray[foundSeqIndex].requestList.length; i++) {
                this.outputLog(this.sentWritePacketArray[foundSeqIndex].requestList[i].itemReference.address.name + ' write completed with quality ' + this.sentWritePacketArray[foundSeqIndex].requestList[i].itemReference.validResponseBuffer, 1, this.connectionId);
                if (this.sentWritePacketArray[foundSeqIndex].requestList[i].itemReference.validResponseBuffer) {
                    const result: { [key: string]: any } = {};
                    result[this.sentWritePacketArray[foundSeqIndex].requestList[i].itemReference.address.userName] = this.sentWritePacketArray[foundSeqIndex].requestList[i].itemReference.writeValue;
                    (this.sentWritePacketArray[foundSeqIndex].requestList[i].itemReference.address.promiseResolve as Function)(result);
                } else {
                    (this.sentWritePacketArray[foundSeqIndex].requestList[i].itemReference.address.promiseReject as Function)();
                }
            }
        } else if (this.sentWritePacketArray[foundSeqIndex].requestList[0].parts > 1 && this.checkWriteResponseParts(this.sentWritePacketArray[foundSeqIndex].writeRequestSequence as number)) {
            // If the sentReadPacket have two or more parts and are already received
            let validResponse: boolean = true;
            const writeRequestSequence: number = this.sentWritePacketArray[foundSeqIndex].requestList[0].writeRequestSequence;
            for (let i = 0; i < this.sentWritePacketArray.length; i++) {
                if (this.sentWritePacketArray[i].writeRequestSequence === writeRequestSequence) {
                    this.outputLog(this.sentWritePacketArray[i].requestList[0].itemReference.address.name + ' write completed with quality ' + this.sentWritePacketArray[i].requestList[0].itemReference.validResponseBuffer, 1, this.connectionId);
                    validResponse = this.sentWritePacketArray[i].requestList[0].itemReference.validResponseBuffer;
                }
            }

            if (validResponse) {
                const result: { [key: string]: any } = {};
                result[this.sentWritePacketArray[foundSeqIndex].requestList[0].itemReference.address.userName] = this.sentWritePacketArray[foundSeqIndex].requestList[0].itemReference.writeValue;
                (this.sentWritePacketArray[foundSeqIndex].requestList[0].itemReference.address.promiseResolve as Function)(result);
            } else {
                (this.sentWritePacketArray[foundSeqIndex].requestList[0].itemReference.address.promiseReject as Function)();
            }
        } else {
            // we must wait until other parts comming for check
            this.outputLog('Wait for parts of write request part ' + this.sentWritePacketArray[foundSeqIndex].writeRequestSequence, 0, this.connectionId);
            canDeletePackets = false;
        }
        if (canDeletePackets) {
            this.sentWritePacketArray = this.sentWritePacketArray.filter((packet): boolean => {
                return packet.writeRequestSequence !== this.sentWritePacketArray[foundSeqIndex].writeRequestSequence;
            });
        }

        // If a response was whit timeout exceeded, the connectionState change to 'disconnected'
        if (this.isoConnectionState === 'disconnected') {
            // Reject all pending requests
            this.rejectAllRequestQueue();
            // reconnect
            this.connectionReset();
        }
    }

    private checkRfcData(data: Buffer): string | Buffer {
        let ret: string | Buffer;
        const rfcVersion: number = data[0];
        const tpktLength: number = data.readInt16BE(2);
        const tpduCode: number = data[5]; //Data==0xF0 !!
        const LastDataUnit: number = data[6]; //empty fragmented frame => 0=not the last package; 1=last package

        if (rfcVersion !== 0x03 && tpduCode !== 0xf0) {
            //Check if its an RFC package and a Data package
            return 'error';
        } else if (LastDataUnit >> 7 === 0 && tpktLength == data.length && data.length === 7) {
            // Check if its a Fast Acknowledge package from older PLCs or  WinAC or data is too long ...
            // For example: <Buffer 03 00 00 07 02 f0 00> => data.length==7
            ret = 'fastACK';
        } else if (LastDataUnit >> 7 == 1 && tpktLength <= data.length) {
            // Check if its an  FastAcknowledge package + S7Data package
            // <Buffer 03 00 00 1b 02 f0 80 32 03 00 00 00 00 00 08 00 00 00 00 f0 00 00 01 00 01 00 f0> => data.length==7+20=27
            ret = data;
        } else if (LastDataUnit >> 7 == 0 && tpktLength !== data.length) {
            // Check if its an  FastAcknowledge package + FastAcknowledge package+ S7Data package
            // Possibly because NodeS7 or Application is too slow at this moment!
            // <Buffer 03 00 00 07 02 f0 00 03 00 00 1b 02 f0 80 32 03 00 00 00 00 00 08 00 00 00 00 f0 00 00 01 00 01 00 f0>  => data.length==7+7+20=34
            ret = data.slice(7, data.length); //Cut off the first Fast Acknowledge Packet
        } else {
            ret = 'error';
        }
        return ret;
    }

    private onPDUReply(theData: Buffer): void {
        (this.client as Socket).removeAllListeners('error');

        clearTimeout(this.PDUTimeout);

        const data = this.checkRfcData(theData);
        if (data === 'fastACK') {
            //Read again and wait for the requested data
            this.outputLog('Fast Acknowledge received.', 0, this.connectionId);

            (this.client as Socket).removeAllListeners('error');

            (this.client as Socket).removeAllListeners('data');

            (this.client as Socket).once('data', (data: Buffer): void => {
                this.onPDUReply(data);
            });

            (this.client as Socket).on('error', (err: Error): void => {
                console.log(err);
                this.readWriteError(new Error('Error on PDURefly'));
            });
        } else if (data instanceof Buffer && data[4] + 1 + 12 + data.readInt16BE(13) === data.readInt16BE(2) - 4) {
            //valid the length of FA+S7 package :  ISO_Length+ISO_LengthItself+S7Com_Header+S7Com_Header_ParameterLength===TPKT_Length-4
            //Everything OK...go on
            // Track the connection state
            this.isoConnectionState = 's7comm'; // Received PDU response, good to go

            const partnerMaxParallel1 = data.readInt16BE(21);
            const partnerMaxParallel2 = data.readInt16BE(23);
            const partnerPDU = data.readInt16BE(25);

            this.maxParallel = this.requestMaxParallel;

            if (partnerMaxParallel1 < this.requestMaxParallel) {
                this.maxParallel = partnerMaxParallel1;
            }
            if (partnerMaxParallel2 < this.requestMaxParallel) {
                this.maxParallel = partnerMaxParallel2;
            }
            if (partnerPDU < this.requestMaxPDU) {
                this.maxPDU = partnerPDU;
            } else {
                this.maxPDU = this.requestMaxPDU;
            }
            this.outputLog('Received PDU Response - Proceeding with PDU ' + this.maxPDU + ' and ' + this.maxParallel + ' max parallel connections.', 0, this.connectionId);
            (this.client as Socket).on('data', (data: Buffer): void => {
                this.onResponse(data);
            });
            (this.client as Socket).on('error', (): void => {
                this.readWriteError(new Error('Error on client 2, onPDUReply function'));
            });

            if (!this.connectCBIssued && typeof this.connectCallback === 'function') {
                this.connectCBIssued = true;
                this.connectCallback();
            }
        } else {
            this.outputLog('INVALID Telegram ', 0, this.connectionId);
            this.outputLog('Byte 0 From Header is ' + theData[0] + ' it has to be 0x03, Byte 5 From Header is  ' + theData[5] + ' and it has to be 0x0F ', 0, this.connectionId);
            this.outputLog('INVALID PDU RESPONSE or CONNECTION REFUSED - DISCONNECTING', 0, this.connectionId);
            this.outputLog('TPKT Length From Header is ' + theData.readInt16BE(2) + ' and RCV buffer length is ' + theData.length + ' and COTP length is ' + theData.readUInt8(4) + ' and data[6] is ' + theData[6], 0, this.connectionId);
            this.outputLog(theData);
            const timeHandler: TimerHandler = (): void => {
                this.connectionReset();
            };
            (this.client as Socket).destroy();
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(timeHandler, 2000);
        }
    }

    private onResponse(theData: Buffer): void {
        // Packet Validity Check.  Note that this will pass even with a "not available" response received from the server.
        // For length calculation and verification:
        // data[4] = COTP header length. Normally 2.  This doesn't include the length byte so add 1.
        // read(13) is parameter length.  Normally 4.
        // read(14) is data length.  (Includes item headers)
        // 12 is length of "S7 header"
        // Then we need to add 4 for TPKT header.

        if (!(theData && theData.length > 6)) {
            this.outputLog('INVALID READ RESPONSE - DISCONNECTING');
            this.outputLog("The incoming packet doesn't have the required minimum length of 7 bytes");
            this.outputLog(theData);
            return;
        }

        const data = this.checkRfcData(theData);
        if (data === 'fastACK') {
            //read again and wait for the requested data
            this.outputLog('Fast Acknowledge received.', 0, this.connectionId);
            (this.client as Socket).removeAllListeners('error');
            (this.client as Socket).removeAllListeners('data');
            (this.client as Socket).on('data', (data: Buffer): void => {
                this.onResponse(data);
            });
            (this.client as Socket).on('error', (): void => {
                this.readWriteError(new Error('Error onisoclient, onReadResponse1'));
            });
        } else if (data instanceof Buffer && data[7] === 0x32) {
            //check the validy of FA+S7 package

            //*********************   VALIDY CHECK ***********************************
            //TODO: Check S7-Header properly
            if (data.length > 8 && data[8] != 3) {
                this.outputLog('PDU type (byte 8) was returned as ' + data[8] + ' where the response PDU of 3 was expected.');
                this.outputLog('Maybe you are requesting more than 240 bytes of data in a packet?');
                this.outputLog(data);
                this.connectionReset();
                return;
            }
            // The smallest read packet will pass a length check of 25.  For a 1-item write response with no data, length will be 22.
            if (data.length > data.readInt16BE(2)) {
                this.outputLog('An oversize packet was detected.  Excess length is ' + (data.length - (data as Buffer).readInt16BE(2)) + '.  ');
                this.outputLog('We assume this is because two packets were sent at nearly the same time by the PLC.');
                this.outputLog('We are slicing the buffer and scheduling the second half for further processing next loop.');
                setTimeout((): void => {
                    this.onResponse(data.slice(data.readInt16BE(2)));
                }, 0); // This re-triggers this same function with the sliced-up buffer.
            }

            if (data.length < data.readInt16BE(2) || data.readInt16BE(2) < 22 || data[5] !== 0xf0 || data[4] + 1 + 12 + 4 + data.readInt16BE(13) + data.readInt16BE(15) !== data.readInt16BE(2) || !(data[6] >> 7) || data[7] !== 0x32 || data[8] !== 3) {
                this.outputLog('INVALID READ RESPONSE - DISCONNECTING');
                this.outputLog('TPKT Length From Header is ' + data.readInt16BE(2) + ' and RCV buffer length is ' + data.length + ' and COTP length is ' + (data as Buffer).readUInt8(4) + ' and data[6] is ' + data[6]);
                this.outputLog(data);
                this.connectionReset();
                return;
            }

            //**********************   GO ON  *************************
            // Log the receive
            this.outputLog('Received ' + data.readUInt16BE(15) + ' bytes of S7-data from PLC.  Sequence number is ' + data.readUInt16BE(11), 0, this.connectionId);

            // Check the sequence number
            let foundSeqNum: number | undefined = undefined;
            let isReadResponse: boolean = false;
            let isWriteResponse: boolean = false;

            if (data[19] === 0x05) {
                // write response
                foundSeqNum = this.findWriteIndexOfSeqNum(data.readUInt16BE(11));
                if (typeof foundSeqNum !== 'undefined') {
                    this.writeResponse(data, foundSeqNum);
                    isWriteResponse = true;
                }
            } else if (data[19] === 0x04) {
                // read response
                foundSeqNum = this.findReadIndexOfSeqNum(data.readUInt16BE(11));
                if (typeof foundSeqNum !== 'undefined') {
                    this.readResponse(data, foundSeqNum);
                    isReadResponse = true;
                }
            }

            if (!isReadResponse && !isWriteResponse) {
                this.outputLog("Sequence number that arrived wasn't a write reply either - dropping");
                this.outputLog(data);
                return;
            }
        } else {
            this.outputLog('INVALID READ RESPONSE - DISCONNECTING');
            this.outputLog('TPKT Length From Header is ' + theData.readInt16BE(2) + ' and RCV buffer length is ' + theData.length + ' and COTP length is ' + theData.readUInt8(4) + ' and data[6] is ' + theData[6]);
            this.outputLog(theData);
            this.connectionReset();
            return;
        }
    }

    private onISOConnectReply(data: Buffer): void {
        (this.client as Socket).removeAllListeners('error');

        clearTimeout(this.connectTimeout);

        // ignore if we're not expecting it - prevents write after end exception as of #80
        if (this.isoConnectionState != 'tcp') {
            this.outputLog('Ignoring ISO connect reply, expecting isoConnectionState of 2, is currently ' + this.isoConnectionState, 0, this.connectionId);
            return;
        }

        // Track the connection state
        this.isoConnectionState = 'isoOnTcp'; // ISO-ON-TCP connected, Wait for PDU response.

        // Expected length is from packet sniffing - some applications may be different, especially using routing - not considered yet.
        if (data.readInt16BE(2) !== data.length || data.length < 22 || data[5] !== 0xd0 || data[4] !== data.length - 5) {
            this.outputLog('INVALID PACKET or CONNECTION REFUSED - DISCONNECTING');
            this.outputLog(data);
            this.outputLog('TPKT Length From Header is ' + data.readInt16BE(2) + ' and RCV buffer length is ' + data.length + ' and COTP length is ' + data.readUInt8(4) + ' and data[5] is ' + data[5]);
            this.connectionReset();
            return;
        }

        this.outputLog('ISO-on-TCP Connection Confirm Packet Received', 0, this.connectionId);
        this.negotiatePDU.writeInt16BE(this.requestMaxParallel, 19);
        this.negotiatePDU.writeInt16BE(this.requestMaxParallel, 21);
        this.negotiatePDU.writeInt16BE(this.requestMaxPDU, 23);

        const timeHandler: TimerHandler = (): void => {
            this.packetTimeout('PDU');
        };

        this.PDUTimeout = setTimeout(timeHandler, this.globalTimeout);
        (this.client as Socket).once('data', (data: Buffer): void => {
            this.onPDUReply(data);
        });

        (this.client as Socket).on('error', (err: Error): void => {
            console.log(err);
            this.readWriteError(new Error('Error on ISO Reply'));
        });

        (this.client as Socket).write(this.negotiatePDU.slice(0, 25));
    }

    private onTCPConnect(): void {
        this.outputLog('TCP Connection Established to ' + (this.client as Socket).remoteAddress + ' on port ' + (this.client as Socket).remotePort, 0, this.connectionId);
        this.outputLog('Will attempt ISO-on-TCP connection', 0, this.connectionId);
        // Track the connection state
        this.isoConnectionState = 'tcp'; // 2 = TCP connected, wait for ISO connection confirmation

        // Send an ISO-on-TCP connection request.

        const timeHandler: TimerHandler = (): void => {
            this.packetTimeout('ISO');
        };
        this.connectTimeout = setTimeout(timeHandler, this.globalTimeout);
        const connBuf = this.connectReq;

        if (this.localTSAP !== undefined && this.remoteTSAP !== undefined) {
            this.outputLog('Using localTSAP [0x' + this.localTSAP.toString(16) + '] and remoteTSAP [0x' + this.remoteTSAP.toString(16) + ']', 0, this.connectionId);
            connBuf.writeUInt16BE(this.localTSAP, 16);
            connBuf.writeUInt16BE(this.remoteTSAP, 20);
        } else {
            this.outputLog('Using rack [' + this.rack + '] and slot [' + this.slot + ']', 0, this.connectionId);
            connBuf[21] = this.rack * 32 + this.slot;
        }

        // Listen for a reply.
        (this.client as Socket).once('data', (data: Buffer): void => {
            this.onISOConnectReply(data);
        });

        // // Hook up the event that fires on disconnect
        (this.client as Socket).on('end', (): void => {
            console.log('end');
            // this.onClientDisconnect();
        });

        // listen for close (caused by us sending an end or caused by timeout socket)
        (this.client as Socket).on('close', (hasError: boolean): void => {
            if (hasError) {
                this.outputLog('Connection has been closed due to a connection error or inactivity');
                this.connectionReset();
            }
        });

        (this.client as Socket).on('error', (err: Error): void => {
            console.log('error');
            this.connectionReset();
            console.log(err);
        });

        (this.client as Socket).write(connBuf);
    }

    private connectNow(): void {
        // prevents any reconnect timer to fire this again
        clearTimeout(this.reconnectTimer);

        // Don't re-trigger.
        if (this.isoConnectionState !== 'disconnected') {
            return;
        }

        this.connectionCleanup();

        this.client = new Socket();

        this.client = connect({
            port: this.ConnectionConfig.port,
            host: this.ConnectionConfig.host,
        });

        this.client.setTimeout(this.ConnectionConfig.timeout || 5000, (): void => {
            (this.client as Socket).destroy();
            this.connectError(new Error('Error connecting - destroying connection'));
        });

        this.client.once('connect', (): void => {
            (this.client as Socket).setTimeout(0);
            this.onTCPConnect();
        });

        this.client.on('error', (err): void => {
            console.log(err);
            (this.client as Socket).destroy();
            this.connectError(new Error('Something went wrong trying to connect'));
        });

        this.outputLog('Attempting to connect to host...', 0, this.connectionId);
    }

    private sendNextRequest(): void {
        const request: RequestQueue = this.requestQueue.shift() as RequestQueue;
        if (request.action === 'read') {
            setTimeout((): void => {
                this.sendReadPacket([request.request as S7PreparedReadRequest]);
            }, 0);
        } else if (request.action === 'write') {
            setTimeout((): void => {
                this.sendWritePacket([request.request as S7PreparedWriteRequest]);
            }, 0);
        }
    }

    private prepareReadPacket(addresses: Address[]): S7PreparedReadRequest[] {
        // Note that for a PDU size of 240, the MOST bytes we can request depends on the number of items.
        // To figure this out, allow for a 247 byte packet.  7 TPKT+COTP header doesn't count for PDU, so 240 bytes of "S7 data".
        // In the response you ALWAYS have a 12 byte S7 header.
        // Then you have a 2 byte parameter header.
        // Then you have a 4 byte "item header" PER ITEM.
        // So you have overhead of 18 bytes for one item, 22 bytes for two items, 26 bytes for 3 and so on.  So for example you can request 240 - 22 = 218 bytes for two items.

        // We can calculate a max byte length for single request as 4*Math.floor((self.maxPDU - 18)/4) - to ensure we don't cross boundaries.

        const addressesToRead = addresses; // Address requested by the user

        // Sort the items using the sort function, by type and offset.
        addressesToRead.sort(this.addressListSorter);

        const readBlockList: OptimizableReadBlocks[] = [];

        readBlockList.push({
            totalbyteLength: addressesToRead[0].byteLength,
            offset: addressesToRead[0].offset,
            byteLengthWithFill: addressesToRead[0].byteLengthWithFill,
            addresses: [],
            isOptimized: true,
        });
        readBlockList[0].addresses.push(addressesToRead[0]);

        let thisBlock = 0;
        const maxByteRequest = 4 * Math.floor((this.maxPDU - 18) / 4); // Absolutely must not break a real array into two requests.  Maybe we can extend by two bytes when not DINT/REAL/INT.
        // Optimize the items into blocks
        for (let i = 1; i < addressesToRead.length; i++) {
            //     // Skip T, C, P types
            if (
                addressesToRead[i].areaS7Code !== readBlockList[thisBlock].addresses[0].areaS7Code || // Can't optimize between areas
                addressesToRead[i].dbNumber !== readBlockList[thisBlock].addresses[0].dbNumber || // Can't optimize across DBs
                !this.isOptimizableArea(addressesToRead[i].areaS7Code) || // Can't optimize T,C (I don't think) and definitely not P.
                addressesToRead[i].offset - readBlockList[thisBlock].addresses[0].offset + addressesToRead[i].byteLength > maxByteRequest || // If this request puts us over our max byte length, create a new block for consistency reasons.
                addressesToRead[i].offset - (readBlockList[thisBlock].addresses[0].offset + readBlockList[thisBlock].addresses[0].byteLength) > this.maxGap
            ) {
                // If our gap is large, create a new block.
                this.outputLog('Skipping optimization of item ' + addressesToRead[i].name, 0, this.connectionId);
                // At this point we give up and create a new block.
                readBlockList.push({
                    totalbyteLength: addressesToRead[i].byteLength,
                    byteLengthWithFill: addressesToRead[i].byteLengthWithFill,
                    offset: addressesToRead[i].offset,
                    addresses: [addressesToRead[i]],
                    isOptimized: false,
                });
                thisBlock = thisBlock + 1;
                // globalReadBlockList[thisBlock].itemReference = itemList[i]; // By reference.
            } else {
                this.outputLog('Attempting optimization of item ' + addressesToRead[i].name + '  ' + thisBlock + ' with ' + readBlockList[thisBlock].addresses[0].name, 0, this.connectionId);
                // This next line checks the maximum.
                // Think of this situation - we have a large request of 40 bytes starting at byte 10.
                //	Then someone else wants one byte starting at byte 12.  The block length doesn't change.
                //
                // But if we had 40 bytes starting at byte 10 (which gives us byte 10-49) and we want byte 50, our byte length is 50-10 + 1 = 41.
                readBlockList[thisBlock].totalbyteLength = Math.max(readBlockList[thisBlock].addresses[0].byteLength, addressesToRead[i].offset - readBlockList[thisBlock].addresses[0].offset + addressesToRead[i].byteLength);

                // Point the buffers (byte and quality) to a sliced version of the optimized block.  This is by reference (same area of memory)
                readBlockList[thisBlock].isOptimized = true;
                readBlockList[thisBlock].addresses.push(addressesToRead[i]);
            }
        }

        let thisRequest: number = 0;
        const requestList: ReadBlock[] = []; // The request list consists of the block list, split into chunks readable by PDU.

        //	outputLog("Preparing the read packet...");

        // Split the blocks into requests, if they're too large.
        for (let i = 0; i < readBlockList.length; i++) {
            // How many parts?
            const parts: number = Math.ceil(readBlockList[i].totalbyteLength / maxByteRequest);
            this.outputLog('globalReadBlockList ' + i + ' parts is ' + parts + ' offset is ' + readBlockList[i].addresses[0].offset + ' MBR is ' + maxByteRequest, 1, this.connectionId);

            this.readRequestSequence += 1;
            if (this.readRequestSequence > 32767) {
                this.readRequestSequence = 1;
            }
            let startByte = readBlockList[i].addresses[0].offset;
            let remainingLength = readBlockList[i].totalbyteLength;

            // // If we're optimized...
            for (let j = 0; j < parts; j++) {
                requestList[thisRequest] = {
                    parts: parts,
                    addresses: readBlockList[i].addresses.map((address): Address => ({ ...address })), // We need a copy of values, not a reference
                    totalbyteLength: readBlockList[i].totalbyteLength,
                    byteLengthWithFill: readBlockList[i].byteLengthWithFill,
                    offset: readBlockList[i].offset,
                    isOptimized: readBlockList[i].isOptimized,
                    readRequestSequence: this.readRequestSequence,
                };
                requestList[thisRequest].offset = startByte;
                requestList[thisRequest].totalbyteLength = Math.min(maxByteRequest, remainingLength);
                requestList[thisRequest].byteLengthWithFill = requestList[thisRequest].totalbyteLength;
                if (requestList[thisRequest].byteLengthWithFill % 2) {
                    requestList[thisRequest].byteLengthWithFill += 1;
                }
                remainingLength -= maxByteRequest;
                thisRequest++;
                startByte += maxByteRequest;
            }
        }
        // The packetizer...
        let requestNumber = 0;

        const readPacketArray: S7PreparedReadRequest[] = [];
        while (requestNumber < requestList.length) {
            // Set up the read packet
            this.masterSequenceNumber += 1;
            if (this.masterSequenceNumber > 32767) {
                this.masterSequenceNumber = 1;
            }

            let numItems = 0;
            this.readReqHeader.copy(this.readReq, 0);

            // Packet's expected reply length
            let packetReplyLength = 12 + 2; //
            let packetRequestLength = 12; //s7 header and parameter header

            readPacketArray.push({
                seqNum: 0,
                requestList: [],
                readRequestSequence: 0,
            });
            const thisPacketNumber = readPacketArray.length - 1;

            readPacketArray[thisPacketNumber].seqNum = this.masterSequenceNumber;
            this.outputLog('Sequence Number is ' + readPacketArray[thisPacketNumber].seqNum, 0, this.connectionId);

            for (let i = requestNumber; i < requestList.length; i++) {
                //outputLog("Number is " + (requestList[i].byteLengthWithFill + 4 + packetReplyLength));
                if (requestList[i].byteLengthWithFill + 4 + packetReplyLength > this.maxPDU || packetRequestLength + 12 > this.maxPDU) {
                    this.outputLog('Splitting request: ' + numItems + ' items, requestLength would be ' + (packetRequestLength + 12) + ', replyLength would be ' + (requestList[i].byteLengthWithFill + 4 + packetReplyLength) + ', PDU is ' + this.maxPDU, 0, this.connectionId);
                    if (numItems === 0) {
                        this.outputLog("breaking when we shouldn't, rlibl " + requestList[i].byteLengthWithFill + ' MBR ' + maxByteRequest, 0, this.connectionId);
                        throw new Error("Somehow write request didn't split properly - exiting.  Report this as a bug.");
                    }
                    break; // We can't fit this packet in here.
                }
                requestNumber++;
                numItems++;
                packetReplyLength += requestList[i].byteLengthWithFill + 4;
                packetRequestLength += 12;

                readPacketArray[thisPacketNumber].requestList.push(requestList[i]);
                readPacketArray[thisPacketNumber].readRequestSequence = requestList[i].readRequestSequence;
            }
        }
        return readPacketArray;
    }

    private sendReadPacket(readPacketArray: S7PreparedReadRequest[]): void {
        this.outputLog('SendReadPacket called', 1, this.connectionId);

        for (let i = 0; i < readPacketArray.length; i++) {
            // If our parallels jobs is on top, we are pushing into the queue
            if (this.parallelJobsNow >= this.maxParallel) {
                this.requestQueue.push({
                    request: readPacketArray[i],
                    action: 'read',
                });
                continue;
            }

            // From here down is SENDING the packet
            this.readReq.writeUInt8(readPacketArray[i].requestList.length, 18);
            this.readReq.writeUInt16BE(19 + readPacketArray[i].requestList.length * 12, 2); // buffer length
            this.readReq.writeUInt16BE(readPacketArray[i].seqNum, 11);
            this.readReq.writeUInt16BE(readPacketArray[i].requestList.length * 12 + 2, 13); // Parameter length - 14 for one read, 28 for 2.
            for (let j = 0; j < readPacketArray[i].requestList.length; j++) {
                this.S7AddrToBuffer(readPacketArray[i].requestList[j].addresses[0], readPacketArray[i].requestList[j].totalbyteLength, readPacketArray[i].requestList[j].byteLengthWithFill, readPacketArray[i].requestList[j].offset, false).copy(this.readReq, 19 + j * 12);
            }
            if (this.isoConnectionState === 's7comm') {
                const timeHandler: TimerHandler = (): void => {
                    this.packetTimeout('read', readPacketArray[i].seqNum);
                };
                this.sentReadPacketArray.push({
                    requestList: readPacketArray[i].requestList,
                    sent: true,
                    rcvd: false,
                    responseBuffer: Buffer.alloc(8192),
                    seqNum: readPacketArray[i].seqNum,
                    readRequestSequence: readPacketArray[i].readRequestSequence,
                    timeout: setTimeout(timeHandler, this.globalTimeout),
                    reqTime: process.hrtime.bigint(),
                });
                this.parallelJobsNow += 1;
                (this.client as Socket).write(this.readReq.slice(0, 19 + readPacketArray[i].requestList.length * 12));
            } else {
                const timeHandler: TimerHandler = (): void => {
                    this.packetTimeout('read', readPacketArray[i].seqNum);
                };
                this.sentReadPacketArray.push({
                    requestList: readPacketArray[i].requestList,
                    sent: true,
                    rcvd: false,
                    responseBuffer: Buffer.alloc(8192),
                    seqNum: readPacketArray[i].seqNum,
                    readRequestSequence: readPacketArray[i].readRequestSequence,
                    timeout: setTimeout(timeHandler, this.globalTimeout),
                    reqTime: process.hrtime.bigint(),
                });
            }
            this.outputLog('Sending Read Packet', 1, this.connectionId);
        }
    }

    private prepareWritePacket(instantWriteBlockList: S7ItemWrite[]): S7PreparedWriteRequest[] {
        const itemList = instantWriteBlockList;

        itemList.sort(this.itemListSorter);

        const maxByteRequest = 4 * Math.floor((this.maxPDU - 18 - 12) / 4); // Absolutely must not break a real array into two requests.  Maybe we can extend by two bytes when not DINT/REAL/INT.

        let thisRequest = 0;

        const requestList: WriteBlock[] = [];

        // Split the blocks into requests, if they're too large.
        for (let i = 0; i < itemList.length; i++) {
            let startByte = itemList[i].address.offset;
            let remainingLength = itemList[i].address.byteLength;
            let lengthOffset = 0;

            // How many parts?
            const parts: number = Math.ceil(itemList[i].address.byteLength / maxByteRequest);
            this.writeRequestSequence += 1;
            if (this.writeRequestSequence > 32767) {
                this.writeRequestSequence = 1;
            }

            for (let j = 0; j < parts; j++) {
                const s7WriteItem: S7ItemWrite = this.S7ItemWrite;
                s7WriteItem.address = { ...itemList[i].address }; // We need a copy of values, not a reference
                s7WriteItem.writeValue = itemList[i].writeValue;
                requestList.push({
                    itemReference: s7WriteItem,
                    isOptimized: false,
                    parts: parts,
                    writeRequestSequence: this.writeRequestSequence,
                });
                requestList[thisRequest].itemReference.address.offset = startByte;
                requestList[thisRequest].itemReference.address.byteLength = Math.min(maxByteRequest, remainingLength);
                requestList[thisRequest].itemReference.address.byteLengthWithFill = requestList[thisRequest].itemReference.address.byteLength;
                if (requestList[thisRequest].itemReference.address.byteLengthWithFill % 2) {
                    requestList[thisRequest].itemReference.address.byteLengthWithFill += 1;
                }

                // Now we convert our value to a buffer
                const writeBuffer = this.bufferizeValue(itemList[i].address, itemList[i].writeValue);

                requestList[thisRequest].itemReference.writeBuffer = Buffer.from(writeBuffer.buffer, lengthOffset, lengthOffset + requestList[thisRequest].itemReference.address.byteLengthWithFill);

                lengthOffset += requestList[thisRequest].itemReference.address.byteLength;

                remainingLength -= maxByteRequest;
                thisRequest++;
                startByte += maxByteRequest;
            }
        }

        const writePacketArray: S7PreparedWriteRequest[] = [];

        // The packetizer...
        let requestNumber = 0;
        while (requestNumber < requestList.length) {
            // Yes this is the same master sequence number shared with the read queue
            this.masterSequenceNumber += 1;
            if (this.masterSequenceNumber > 32767) {
                this.masterSequenceNumber = 1;
            }

            let numItems = 0;

            // Maybe this shouldn't really be here?
            this.writeReqHeader.copy(this.writeReq);

            // Packet's length
            let packetWriteLength = 10 + 4; // 10 byte header and 4 byte param header

            writePacketArray.push({
                requestList: [],
                seqNum: 0,
                writeRequestSequence: 0,
            });

            const thisPacketNumber = writePacketArray.length - 1;
            writePacketArray[thisPacketNumber].seqNum = this.masterSequenceNumber;
            // this.outputLog('Write Sequence Number is ' + writePacketArray[thisPacketNumber].seqNum);

            writePacketArray[thisPacketNumber].requestList = []; // Initialize as array.

            for (let i = requestNumber; i < requestList.length; i++) {
                // this.outputLog('Number is ' + (requestList[i].itemReference.address.byteLengthWithFill + 4 + packetWriteLength));
                if (requestList[i].itemReference.address.byteLengthWithFill + 12 + 4 + packetWriteLength > this.maxPDU) {
                    // 12 byte header for each item and 4 bytes for the data header
                    if (numItems === 0) {
                        this.outputLog('breaking when we shouldnt, byte length with fill is  ' + requestList[i].itemReference.address.byteLengthWithFill + ' max byte request ' + maxByteRequest, 0, this.connectionId);
                        this.lastError = 'Somehow write request didnt split properly - exiting.  Report this as a bug.';
                        throw new Error(this.lastError);
                    }
                    break; // We can't fit this packet in here.
                }
                requestNumber++;
                numItems++;
                packetWriteLength += requestList[i].itemReference.address.byteLengthWithFill + 12 + 4; // Don't forget each request has a 12 byte header as well.

                writePacketArray[thisPacketNumber].requestList.push(requestList[i]);
                writePacketArray[thisPacketNumber].writeRequestSequence = requestList[i].writeRequestSequence;
            }
        }
        return writePacketArray;
    }

    private sendWritePacket(writePacketArray: S7PreparedWriteRequest[]): void {
        let itemBuffer: Buffer, dataBufferPointer: number;

        const dataBuffer: Buffer = Buffer.alloc(8192);
        for (let i = 0; i < writePacketArray.length; i++) {
            // If our parallels jobs is on top, we are pushing into the queue
            if (this.parallelJobsNow >= this.maxParallel) {
                this.requestQueue.push({
                    request: writePacketArray[i],
                    action: 'write',
                });
                continue;
            }
            // From here down is SENDING the packet
            this.writeReq.writeUInt8(writePacketArray[i].requestList.length, 18);
            this.writeReq.writeUInt16BE(writePacketArray[i].seqNum, 11);

            dataBufferPointer = 0;
            for (let j = 0; j < writePacketArray[i].requestList.length; j++) {
                this.S7AddrToBuffer(writePacketArray[i].requestList[j].itemReference.address, writePacketArray[i].requestList[j].itemReference.address.byteLength, writePacketArray[i].requestList[j].itemReference.address.byteLengthWithFill, writePacketArray[i].requestList[j].itemReference.address.offset, true).copy(this.writeReq, 19 + j * 12);

                itemBuffer = this.getWriteBuffer(writePacketArray[i].requestList[j].itemReference);

                itemBuffer.copy(dataBuffer, dataBufferPointer);
                dataBufferPointer += itemBuffer.length;
                // NOTE: It seems that when writing, the data that is sent must have a "fill byte" so that data length is even only for all
                //  but the last request.  The last request must have no padding.  So we add the padding here.
                if (j < writePacketArray[i].requestList.length - 1) {
                    if (itemBuffer.length % 2) {
                        dataBufferPointer += 1;
                    }
                }
            }

            this.writeReq.writeUInt16BE(19 + writePacketArray[i].requestList.length * 12 + dataBufferPointer, 2); // buffer length
            this.writeReq.writeUInt16BE(writePacketArray[i].requestList.length * 12 + 2, 13); // Parameter length - 14 for one read, 28 for 2.
            this.writeReq.writeUInt16BE(dataBufferPointer, 15); // Data length - as appropriate.

            dataBuffer.copy(this.writeReq, 19 + writePacketArray[i].requestList.length * 12, 0, dataBufferPointer);

            if (this.isoConnectionState === 's7comm') {
                // this.outputLog('writing' + (19 + dataBufferPointer + writePacketArray[i].requestList.length * 12));
                const timeHandler: TimerHandler = (): void => {
                    this.packetTimeout('write', writePacketArray[i].seqNum);
                };
                this.sentWritePacketArray.push({
                    requestList: writePacketArray[i].requestList,
                    sent: true,
                    rcvd: false,
                    seqNum: writePacketArray[i].seqNum,
                    timeout: setTimeout(timeHandler, this.globalTimeout),
                    writeRequestSequence: writePacketArray[i].writeRequestSequence,
                    reqTime: process.hrtime.bigint(),
                });
                this.parallelJobsNow += 1;
                (this.client as Socket).write(this.writeReq.slice(0, 19 + dataBufferPointer + writePacketArray[i].requestList.length * 12)); // was 31
                this.outputLog('Sending Write Packet With Sequence Number ' + writePacketArray[i].seqNum, 0, this.connectionId);
            } else {
                const timeHandler: TimerHandler = (): void => {
                    this.packetTimeout('write', writePacketArray[i].seqNum);
                };
                this.sentWritePacketArray.push({
                    requestList: writePacketArray[i].requestList,
                    sent: true,
                    rcvd: false,
                    seqNum: writePacketArray[i].seqNum,
                    timeout: setTimeout(timeHandler, this.globalTimeout),
                    writeRequestSequence: writePacketArray[i].writeRequestSequence,
                    reqTime: process.hrtime.bigint(),
                });
            }
        }
    }

    public initiateConnection(callback?: Function): void {
        this.connectCallback = callback;
        this.connectNow();
    }

    public async readItems(directions: string[]): Promise<any> {
        if (this.isoConnectionState !== 's7comm') {
            this.lastError = 'Unable to read when not connected.';
            this.outputLog(this.lastError, 0, this.connectionId);
            return Promise.reject(new Error(this.lastError));
        }
        const addresses: Address[] = await this.stringArrayToS7AddressArray(directions, 'read');
        const promises: Promise<any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
        addresses.forEach((address): void => {
            const promise = new Promise((resolve, reject): void => {
                address.promiseResolve = resolve;
                address.promiseReject = reject;
            });
            promises.push(promise);
        });

        const preparedReadRequest: S7PreparedReadRequest[] = this.prepareReadPacket(addresses);
        this.sendReadPacket(preparedReadRequest); // Note this sends the first few read packets depending on parallel connection restrictions.

        return Promise.all(promises)
            .then((values: any): void => {
                return Object.assign({}, ...values);
            })
            .catch((err): void => {
                throw new Error(err);
            });
    }

    public async writeItems(directions: string[], value: any[]): Promise<any> {
        if (this.isoConnectionState !== 's7comm') {
            this.lastError = 'Unable to write when not connected.';
            this.outputLog(this.lastError, 0, this.connectionId);
            return Promise.reject(new Error(this.lastError));
        }
        this.outputLog('Preparing to WRITE ' + directions + ' to value ' + value, 0, this.connectionId);
        let addresses: Address[] = [];
        try {
            addresses = await this.stringArrayToS7AddressArray(directions, 'write');
        } catch (err) {
            return Promise.reject(err);
        }

        const instantWriteBlockList: S7ItemWrite[] = []; // Initialize the array.

        const promises: Promise<any>[] = [];
        addresses.forEach((address, index): void => {
            const promise = new Promise((resolve, reject): void => {
                address.promiseResolve = resolve;
                address.promiseReject = reject;
            });
            const s7ItemWrite = this.S7ItemWrite;
            s7ItemWrite.address = address;
            s7ItemWrite.writeValue = value[index];
            instantWriteBlockList.push(s7ItemWrite);
            promises.push(promise);
        });

        const writePacketArray: S7PreparedWriteRequest[] = this.prepareWritePacket(instantWriteBlockList);

        this.sendWritePacket(writePacketArray);

        return Promise.all(promises)
            .then((values: any): void => {
                return Object.assign({}, ...values);
            })
            .catch((): void => {
                throw new Error(this.lastError);
            });
    }

    private get Address(): Address {
        return {
            name: '',
            userName: '',
            Type: 'C',
            dataType: '',
            dbNumber: 0,
            bitOffset: 0,
            offset: 0,
            arrayLength: 0,
            dataTypeLength: 0,
            areaS7Code: 0x1c,
            byteLength: 0,
            byteLengthWithFill: 0,
            transportCode: 0x04,
            valid: true,
        };
    }

    private get S7ItemWrite(): S7ItemWrite {
        return {
            address: this.Address,
            quality: '',
            writeQuality: '',
            writeResponse: 0,
            writeBuffer: Buffer.alloc(8192),
            writeValue: 0,
            valid: false,
            errCode: '',
            validResponseBuffer: false,
            resultReference: undefined,
        };
    }
}

export type PacketTimeout = 'ISO' | 'PDU' | 'read' | 'write';

export type ConnectionState = 'disconnected' | 'tcp' | 'isoOnTcp' | 's7comm';

export interface ConnectionConfig {
    port: number;
    host: string;
    rack?: number;
    slot?: number;
    timeout?: number;
    silentMode?: boolean;
    localTSAP?: number;
    remoteTSAP?: number;
    callback?: Function;
    connectionName?: string;
}

export interface SendReadRequest {
    seqNum: number; // Made-up sequence number to watch for.
    requestList: ReadBlock[]; // This will be assigned the object that details what was in the request.
    reqTime: bigint;
    responseBuffer: Buffer;
    sent: boolean; // Have we sent the packet yet?
    rcvd: boolean; // Are we waiting on a reply?
    timeout: number; // The timeout for use with clearTimeout()
    readRequestSequence: number; // If a request are splitter in 2 or more parts
}

export interface SendWriteRequest {
    seqNum: number; // Made-up sequence number to watch for.
    requestList: WriteBlock[]; // This will be assigned the object that details what was in the request.
    reqTime: bigint;
    sent: boolean; // Have we sent the packet yet?
    rcvd: boolean; // Are we waiting on a reply?
    timeout: number; // The timeout for use with clearTimeout()
    writeRequestSequence: number; // Number of parts that the request are splitter in 2 or more parts
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

export interface RequestQueue {
    request: S7PreparedReadRequest | S7PreparedWriteRequest;
    action: 'read' | 'write';
}

export interface Address {
    name: string; // s7 address
    userName: string; // original address
    Type: string; // 'DB' | 'I' | 'PI' | 'Q' | 'PQ' | 'M' | 'C' | 'T'
    dataType: string; // type of address (INT, REAL, X, STRING...)
    dbNumber: number; // datablock number DB1,REAL8 => 1
    bitOffset: number; // bitoffset of address DB1,X13.2 => 2 only works with types X
    offset: number; // offset of data DB1,REAL8 => 8
    arrayLength: number; // values to read in sequence MX2.2.3 => 3, default 1
    dataTypeLength: number; // bytes requiered for datatype INT => 2, REAL => 4, X => 1
    areaS7Code: 0x84 | 0x81 | 0x82 | 0x83 | 0x80 | 0x1c | 0x1d; // s7 areas 0x84, 0x81, 0x82, 0x83, 0x80, 0x1c, 0x1d
    byteLength: number; // total bytes
    byteLengthWithFill: number; // byte with fill % 2
    transportCode: 0x04 | 0x09 | 0x03;
    valid: boolean; // If the stored adrress is valid
    promiseResolve?: Function; // We store a resolve function for each address to read or write
    promiseReject?: Function; // We store a reject function for each address to read or write
}

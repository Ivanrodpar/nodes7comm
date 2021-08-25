import { Address } from './types/address.types';
import { S7ItemWrite } from './types/request.types';

export function getEmptyAddress(): Address {
    return {
        name: '',
        userName: '',
        Type: '',
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

export function getEmptyS7ItemWrite(): S7ItemWrite {
    return {
        address: getEmptyAddress(),
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

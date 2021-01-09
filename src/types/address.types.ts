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

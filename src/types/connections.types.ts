export type PacketTimeout = 'ISO' | 'PDU' | 'read' | 'write';

export type ConnectionState = 'disconnected' | 'TCP' | 'ISOOnTCP' | 's7comm';

export interface ConnectionConfig {
    host: string;
    port: number;
    rack?: number;
    slot?: number;
    timeout?: number;
    silentMode?: boolean;
    localTSAP?: number;
    remoteTSAP?: number;
    _callback?: any;
    connectionName?: string;
    autoConnect?: boolean;
}

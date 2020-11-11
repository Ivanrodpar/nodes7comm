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

export type PacketTimeout = 'ISO' | 'PDU' | 'read' | 'write';

export type ConnectionState = 'disconnected' | 'tcp' | 'isoOnTcp' | 's7comm';

export interface Nodes7CommConfig {
    host: string;
    port?: number;
    rack?: number;
    slot?: number;
    connectionTimeout?: number;
    requestTimeout?: number;
    localTSAP?: number;
    remoteTSAP?: number;
    callback?: any;
    connectionName?: string;
    optimize?: boolean;
    autoReconnect?: boolean;
    logLevel?: 'none' | 'error' | 'warn' | 'info';
}

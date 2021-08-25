export interface NodeS7CommEvents {
    connected: () => void;
    'connect-timeout': () => void;
    disconnected: (reason: string) => void;
    error: (error: Error) => void;
}

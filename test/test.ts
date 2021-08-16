import { S7Comm, ConnectionConfig } from './index';

async function test(): Promise<void> {
    const options: ConnectionConfig = {
        host: '',
        port: 1,
    };
    const s7Client = new S7Comm(options);
}

test();

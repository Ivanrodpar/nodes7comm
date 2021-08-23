import { S7Comm, Nodes7CommConfig } from '../index';

async function test(): Promise<void> {
    const options: Nodes7CommConfig = {
        host: '192.168.1.200',
        // logLevel: 'info',
    };
    const s7Client = new S7Comm(options);
    try {
        const tags = {
            a: 'DB100,REAL22',
            b: 'DB100,REAL26',
            c: 'DB100,REAL30',
        };
        s7Client.addTranslationItems(tags);
        s7Client.addTags(Object.keys(tags));
        s7Client.initiateConnection();
        s7Client.on('error', (err) => {
            console.log('onError', err);
        });
        s7Client.on('disconnected', () => {
            console.log('onDisconnected');
        });
        s7Client.on('connected', () => {
            console.log('onConnected');
            read(s7Client);
        });
        s7Client.on('connect-timeout', () => {
            console.log('onConnectTimeout');
        });
    } catch (err) {
        console.log(err);
    }
}

async function read(s7Client: S7Comm): Promise<void> {
    setTimeout(async () => {
        try {
            const response = await s7Client.readTags('a');
            console.log(response);
            const response2 = await s7Client.writeTags('a', response.a > 0 ? 0 : 1);
            read(s7Client);
        } catch (err) {
            console.log(err);
        }
    }, 1000);
}

test();

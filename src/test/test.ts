import { NodeS7Comm, Nodes7CommConfig } from '../index';

async function test(): Promise<void> {
    const options: Nodes7CommConfig = {
        host: '192.168.1.200',
    };
    const s7Client = new NodeS7Comm(options);
    try {
        s7Client.initiateConnection();
        s7Client.on('error', (err) => {
            console.log('onError', err);
        });
        s7Client.on('disconnected', () => {
            console.log('onDisconnected');
        });
        s7Client.on('connected', async () => {
            const tags = {
                input: 'I0.0',
                output: 'Q0.0',
            };
            s7Client.addTranslationTags(tags);
            s7Client.addTags(Object.keys(tags));
            read(s7Client);
        });
        s7Client.on('connect-timeout', () => {
            console.log('onConnectTimeout');
        });
    } catch (err) {
        console.log(err);
    }
}

async function read(s7Client: NodeS7Comm): Promise<void> {
    setTimeout(async () => {
        try {
            const response = await s7Client.readAllTags();
            console.log(response);
            await s7Client.writeTags('output', response.output ? false : true);
            read(s7Client);
        } catch (err) {
            console.log(err);
        }
    }, 1000);
}

test();

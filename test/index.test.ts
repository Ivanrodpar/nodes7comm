import { ConnectionConfig, S7Comm } from '../src/index';

const connectionConfig: ConnectionConfig = {
    host: '192.168.1.200',
    port: 102,
    silentMode: false,
    autoConnect: true,
};
(async function () {
    const s7 = new S7Comm(connectionConfig);
    s7.on('timeout', (err) => {
        console.log(err);
    });
    await s7.initiateConnection();
    s7.on('error', (err) => {
        console.log(err);
    });
    s7.on('connect', () => {
        console.log('connected');
    });
})();

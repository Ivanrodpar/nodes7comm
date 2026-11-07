// Type-level tests of the published API: `tsc -p test/types` checks this file against lib/*.d.ts, the way a
// consumer's project would. Nothing here runs. Every @ts-expect-error must still be an error, so if a type
// degraded to `any` the build would fail on "Unused '@ts-expect-error' directive".

import { NodeS7Comm, S7Error } from '../../lib/index.js';
import type { NodeS7CommEvents, Nodes7CommConfig, S7ErrorCode, S7Value } from '../../lib/index.js';

type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const expectType = <T extends true>(): T | undefined => undefined;

const config: Nodes7CommConfig = { host: '192.168.0.1', logLevel: 'info', reconnectDelay: 500 };
// @ts-expect-error reconnectDelay is a number of milliseconds
export const wrongDelay: Nodes7CommConfig = { host: '192.168.0.1', reconnectDelay: '2s' };
const client = new NodeS7Comm(config);

export async function reads(): Promise<void> {
    // The keys come from the arguments
    const one = await client.readTags('DB1,INT0');
    expectType<Equals<typeof one, Record<'DB1,INT0', S7Value>>>();

    const several = await client.readTags(['DB1,INT0', 'M0.0']);
    expectType<Equals<typeof several, Record<'DB1,INT0' | 'M0.0', S7Value>>>();
    // @ts-expect-error a key that wasn't requested
    void several['DB1,INT2'];

    // A known value type can be given explicitly
    const typed = await client.readTags<number>('DB1,INT0');
    expectType<Equals<typeof typed, Record<string, number>>>();
    // @ts-expect-error the type must be a possible S7 value
    await client.readTags<Date>('DB1,INT0');

    const tags = ['MB0', 'MB1'] as const;
    const fromConst = await client.readTags(tags);
    expectType<Equals<typeof fromConst, Record<'MB0' | 'MB1', S7Value>>>();

    const all = await client.readAllTags();
    expectType<Equals<typeof all, Record<string, S7Value>>>();
}

export async function writes(): Promise<void> {
    await client.writeTags('DB1,INT0', 5);
    await client.writeTags('DB1,INT0.3', [-1, 0, 1]);
    await client.writeTags('DB99,S0.50', 'Hello');
    const written = await client.writeTags(['DB1,INT0', 'M0.0'], [5, true]);
    expectType<Equals<typeof written, Record<'DB1,INT0' | 'M0.0', S7Value>>>();

    // @ts-expect-error several tags need an array with one value each
    await client.writeTags(['DB1,INT0', 'M0.0'], 5);
    // @ts-expect-error not a possible S7 value
    await client.writeTags('DB1,INT0', { value: 5 });
}

export function events(): void {
    client.on('connected', () => undefined);
    client.on('disconnected', (reason: string) => reason);
    client.once('error', (error: Error) => error.message);
    client.off('connect-timeout', () => undefined);
    client.prependListener('disconnected', reason => reason.toUpperCase());

    // @ts-expect-error unknown event
    client.on('nope', () => undefined);
    // @ts-expect-error once is typed too: disconnected passes a string
    client.once('disconnected', (reason: number) => reason);
    // @ts-expect-error connected passes nothing
    client.addListener('connected', (value: string) => value);

    const listener: NodeS7CommEvents['error'] = error => console.log(error.message);
    client.on('error', listener);
}

export async function errors(): Promise<void> {
    try {
        await client.readTags('DB1,INT0');
    } catch (err) {
        if (err instanceof S7Error) {
            expectType<Equals<typeof err.code, S7ErrorCode>>();
            expectType<Equals<typeof err.plcCode, number | undefined>>();
            if (err.code === 'PLC_ERROR') {
                console.log(err.plcCode, err.tag);
            }
            // @ts-expect-error not an S7ErrorCode
            if (err.code === 'Timeout') {
                return;
            }
        }
    }
    await client.disconnect();
}

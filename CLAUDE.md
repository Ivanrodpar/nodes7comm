# nodes7comm

Librería TypeScript publicada en npm para comunicarse con PLCs Siemens S7-300/400/1200/1500 usando el protocolo S7 sobre ISO-on-TCP (puerto 102). Es un port de [nodeS7](https://github.com/plcpeople/nodeS7). No tiene dependencias de runtime y debe seguir así.

## Comandos

- `npm run build`: compila `src/` → `lib/` con `tsc` (`lib/` está en `.gitignore`).
- `npx tsc --noEmit`: type-check.
- `npm run lint`: ESLint 10 con flat config (`eslint.config.mjs`), con typescript-eslint y prettier como regla.
- `npm test`: compila y corre la suite de `test/` con `node:test` contra un PLC simulado. Tarda menos de 1 s.
- Un solo archivo o test: `npx tsc && node --test --test-name-pattern="<nombre>" test/<archivo>.test.ts`.
- `npm run test:plc`: el script manual `src/test/test.ts` contra un PLC real en `192.168.1.200`. Con `autoReconnect` reintenta en bucle si no hay PLC.

## Arquitectura

Todo vive en una sola clase, `NodeS7Comm` (`src/nodes7comm.ts`, ~2400 líneas), que extiende `EventEmitter`. Los tipos internos están en `src/types/`. `src/index.ts` solo exporta `NodeS7Comm` y `Nodes7CommConfig`; todo lo demás es privado.

**Conexión** (`connectNow`): TCP (`initTCPConnect`) → COTP connection request/confirm (`initISOConnect` / `onISOConnectReply`) → negociación de PDU (`initPDUConnect` / `onPDUReply`, que fija `maxPDU` y `maxParallel`) → estado `s7comm` → evento `connected`.

**Lectura**: `readTags` → `stringToS7Addr` (parsea direcciones como `DB1,REAL4` o `M0.0`) → `prepareReadPacket` (ordena, agrupa direcciones cercanas si `optimize`, parte los bloques mayores que `maxByteRequest` en varias *parts* con el mismo `readRequestSequence` y empaqueta lo que cabe en el PDU) → `sendReadPacket` (respeta `maxParallel`; el resto va a `requestQueue`) → `onResponse` → `readResponse` → `BufferToAddressValue`. Cada dirección guarda su propio `promiseResolve`/`promiseReject`, y `readTags` devuelve un `Promise.all` de todas.

**Escritura**: mismo patrón con `prepareWritePacket` / `bufferizeValue` / `sendWritePacket` / `writeResponse`.

## Cuidado con el protocolo

- Los offsets y números mágicos (`dataPointer = 21`, las cabeceras `readReqHeader`/`writeReqHeader`/`connectReq`/`negotiatePDU`, los bytes de relleno para longitudes impares, `maxByteRequest = 4 * floor((maxPDU - 18) / 4)`) vienen de nodeS7 y del protocolo. No los "limpies" sin una prueba que cubra el caso.
- Los números de secuencia se reinician al pasar 32767.
- Un S7-1200/300 suele negociar PDU 240 (~220 bytes útiles por item) y un S7-1500, 960. Prueba con ambos tamaños.

## Tests

- Usan el runner que trae Node (`node:test` + `node:assert/strict`), sin dependencias.
- Están escritos en TypeScript y Node los ejecuta quitando los tipos, así que solo se admite sintaxis "borrable": nada de `enum`, `namespace` ni parameter properties; los imports de tipos van con `import type`, y los imports relativos llevan la extensión `.ts`. `tsc` todavía no los revisa (solo compila `src/`).
- Importan el `lib/` **compilado** (`../lib/index.js`), así que prueban lo que se publica. Por eso `npm test` compila primero.
- `test/package.json` (`"type": "module"`) existe para que Node trate los tests como ESM sin avisos. No lo borres.
- `test/helpers/fake-plc.ts` simula un PLC: memoria por área y DB (`plc.db(1)`, `plc.area(AREA.M)`), registro de lo que recibe (`plc.jobs`, `plc.connectionRequests`) e interruptores de fallo (`silent`, `responseDelay`, `splitResponses`, `itemReturnCode`, `invalidPduReply`, `ignoreConnectionRequests`, `pduSize`, `maxParallel`). No simula timers ni counters.
- Crea los clientes con `connectClient`/`createClient` (por defecto `autoReconnect: false`) y llama a `disposeClients()` en `afterEach`. Mientras no exista un `disconnect()` público, ese helper cierra el socket accediendo al estado privado del cliente.
- Espera (`await`) todas las promesas del cliente: un rechazo sin manejar tira el proceso del test.
- Los tests existentes fijan el comportamiento **actual**, incluso el raro (por ejemplo, que el rechazo por timeout sea el string `'Timeout'`, o que `readAllTags()` sin tags devuelva `[]`). Si un cambio rompe uno de ellos, es un cambio de API: decide si va a un major.

## Deuda conocida (verificada el 2026-10-31; actualiza esta lista al corregir cada punto)

Cada bug tiene un test en `test/known-bugs.test.ts` que describe el comportamiento correcto y está en *skip*. Para corregir uno: ejecuta su test con `RUN_KNOWN_BUGS=1` y `--test-name-pattern` (de uno en uno, porque varios tiran el proceso), arregla el código, quita el `knownBug(...)` del test y bórralo de esta lista.

- Leer un solo tag mayor que `maxByteRequest` (por ejemplo `DB1,S0.254` con PDU 240) tira el proceso con un `TypeError`, porque `readResponse` usa `sentWritePacketArray` en la rama de lectura multiparte. Además, `checkReadResponseParts`/`checkWriteResponseParts` devuelven la condición invertida y el buffer de ensamblado usa `dataTypeLength` en vez de `byteLength`.
- Escribir un solo tag mayor que el PDU rechaza con `'Invalid response'`. Luego, cuando vence el timeout de la segunda parte, tira el proceso (`packetTimeout` → `writeResponse(undefined, -1)`).
- `addTags([...])` con tags ya existentes hace `splice(index, 1)` con el índice del array equivocado: muta el array de quien llama, duplica tags y se salta otros.
- `connectNow` no hace `await` a `onPDUReply`. Un PDU inválido produce un unhandled rejection (que tira el proceso) y aun así se emite `connected`.
- Con `autoReconnect`, un `ECONNREFUSED` reconecta sin ninguna espera y genera miles de eventos `error` por segundo.
- `onResponse` asume que cada evento `data` del socket trae paquetes completos. Si una respuesta llega partida en dos segmentos TCP, desconecta y el request termina en `'Timeout'`.
- `DB12,D40`, la forma que documenta el README para DWord, rechaza con `Unknown data type: D`. Además, el README pone ejemplos de DInt (`ID140`, `MD100`, `DB2,D100`) que en realidad son DWord o no funcionan; lo correcto es `IDI`/`MDI`/`DB2,DI100`.
- `DB1,STRING0.10` (con `STRING` en vez de `S`) calcula una longitud de 0 bytes, no envía nada y la promesa nunca se resuelve.
- `writeTags('DB1,INT0.3', [-1, 0, 1])` (un tag como string y el array como valor) escribe ceros. Solo funciona `writeTags(['DB1,INT0.3'], [[-1, 0, 1]])`.
- `bufferizeValue` usa `writeInt32BE` para arrays DWORD, así que valores ≥ 2^31 rechazan con `RangeError`.
- Sin verificar: en `S7AddrToBuffer` la rama de timers/counters compara `address.Type === 'TIMER'`, pero `Type` vale `'T'`/`'C'`, así que esa rama nunca se ejecuta.
- No hay un método público para desconectar.
- Las promesas se rechazan con strings (`'Timeout'`), no con `Error`.

## Herramientas (actualizadas el 2026-10-31)

- TypeScript está fijado en `~6.0.x` a propósito: typescript-eslint 8 solo soporta `typescript <6.1.0`, y TypeScript 7 (el compilador en Go) todavía no es compatible. Antes de subirlo, revisa el `peerDependencies` de `typescript-eslint`.
- `tsconfig.json` compila a ES2022 con `module: nodenext`. Como `package.json` no tiene `"type": "module"`, la salida es CommonJS. `target: es5` y `moduleResolution: node` ya no son válidos desde TS 6.
- `src/nodes7comm.ts` y `src/types/request.types.ts` tienen `/// <reference types="node" preserve="true" />`. No la quites: sin ella, los `.d.ts` publicados pierden la referencia a `@types/node` (TS ≥5.5 ya no la genera).
- La fusión interfaz + clase de `NodeS7Comm` (eventos tipados) tiene `eslint-disable` a propósito; reemplazarla por `EventEmitter<Events>` cambia los tipos públicos.
- `npm audit` reporta avisos solo en herramientas de desarrollo: `minimatch` (lo traen ESLint y typescript-eslint, sin arreglo publicado) y `diff` (lo trae ts-node, que ya no se mantiene). No se publican.

## Convenciones

- Código y comentarios en inglés. Prettier usa 4 espacios, comillas simples y `printWidth: 1200`: las líneas largas son intencionales, no las partas a mano.
- Commits estilo Conventional Commits (`fix:`, `feat:`, `docs:`, `build:`, `release:`).
- Se trabaja en `dev` y se integra en `master`.
- `CHANGELOG.md` se mantiene a mano, con una sección "Breaking Changes" cuando aplica.
- La API pública sigue semver; cambiar una firma o un tipo de retorno es un cambio major. Esa API son los métodos `initiateConnection`, `readTags`, `writeTags`, `addTags`, `removeTags`, `readAllTags`, `addTranslationTags` y `deleteTranslationTag`, y los eventos `connected`, `connect-timeout`, `disconnected` y `error`.

## Publicación

- `package.json` tiene `"files": ["lib"]`, así que solo se publican `lib/`, README, LICENSE y package.json (ni este archivo ni `test/`).
- No hay `prepublishOnly`: corre `npm run build` antes de `npm publish`, o se publicará un `lib/` viejo.
- La 2.0.0 se publicó compilada a ES5. Desde la actualización de herramientas, `lib/` sale en ES2022, que requiere Node ≥16.11 en quien instala. Anótalo en el CHANGELOG del próximo release y considera agregar `engines`.

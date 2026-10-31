# nodes7comm

Librería TypeScript publicada en npm para comunicarse con PLCs Siemens S7-300/400/1200/1500 usando el protocolo S7 sobre ISO-on-TCP (puerto 102). Es un port de [nodeS7](https://github.com/plcpeople/nodeS7). No tiene dependencias de runtime y debe seguir así.

## Comandos

- `npm run build`: compila `src/` → `lib/` con `tsc` (`lib/` está en `.gitignore`).
- `npx tsc --noEmit`: type-check.
- `npm run lint`: ESLint 10 con flat config (`eslint.config.js`), con typescript-eslint y prettier como regla. Revisa los `.ts` y también los `.js` de configuración.
- `npm test`: compila y corre la suite de `test/` con `node:test` contra un PLC simulado. Tarda menos de 1 s.
- Un solo archivo o test: `npx tsc && node --test --test-name-pattern="<nombre>" test/<archivo>.test.ts`.
- `npm run test:plc`: ejecuta directamente con Node (sin compilar) el script manual `src/test/test.ts` contra un PLC real en `192.168.1.200`. **Escribe en el PLC**: no lo ejecutes sin que el autor lo pida. Con `autoReconnect` reintenta en bucle si no hay PLC.
- Para desarrollar hace falta Node ≥22.18, que ejecuta TypeScript sin compilar, y es lo que usan los tests y `test:plc`. Quien instala el paquete solo necesita lo que dice `engines`.

## Arquitectura

Todo vive en una sola clase, `NodeS7Comm` (`src/nodes7comm.ts`, ~2400 líneas), que extiende `EventEmitter`. Los tipos internos están en `src/types/`. `src/index.ts` solo exporta `NodeS7Comm` y `Nodes7CommConfig`; todo lo demás es privado. La clase se mantiene en un solo archivo por decisión del autor: no propongas dividirla en módulos.

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
- `test/helpers/fake-plc.ts` simula un PLC: memoria por área y DB (`plc.db(1)`, `plc.area(AREA.M)`), registro de lo que recibe (`plc.jobs`, `plc.connectionRequests`) e interruptores de fallo (`silent`, `responseDelay`, `splitResponses`, `itemReturnCode`, `invalidPduReply`, `ignoreConnectionRequests`, `pduSize`, `maxParallel`). No simula timers ni counters.
- Crea los clientes con `connectClient`/`createClient` (por defecto `autoReconnect: false`) y llama a `disposeClients()` en `afterEach`. Mientras no exista un `disconnect()` público, ese helper cierra el socket accediendo al estado privado del cliente.
- Espera (`await`) todas las promesas del cliente: un rechazo sin manejar tira el proceso del test.
- Los tests existentes fijan el comportamiento **actual**, incluso el raro (por ejemplo, que el rechazo por timeout sea el string `'Timeout'`, o que `readAllTags()` sin tags devuelva `[]`). Si un cambio rompe uno de ellos, es un cambio de API: está permitido porque el próximo release es la 3.0.0, pero tiene que ser intencional. Actualiza el test y anótalo en `## Breaking Changes` de `Unreleased`.

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
- El paquete es **solo ESM** (`"type": "module"`); no hay build CommonJS. Quien usa CommonJS hace `require()` del ESM, que Node soporta desde 20.19 / 22.12.
- `tsconfig.json` compila a ES2022 con `module: nodenext`, más `verbatimModuleSyntax`, `erasableSyntaxOnly` y `rewriteRelativeImportExtensions`. Esto obliga a tres cosas en `src/`:
  - los imports relativos llevan la extensión `.ts` (`tsc` la reescribe a `.js` en `lib/`);
  - lo que solo es tipo se importa con `import type`;
  - nada de sintaxis que Node no pueda borrar (`enum`, `namespace`, parameter properties).

  Gracias a eso Node puede ejecutar `src/` sin compilar.
- Los `.d.ts` de `lib/` conservan los `.ts` en sus imports (TS no los reescribe). Funciona para quien instala con TS ≥5.0; con TS 4.9 los tipos quedan como `any`. Verificado el 2026-10-31 con TS 4.9, 5.0, 5.4, 5.7, 5.8 y 6.0, en los modos `nodenext` (ESM y CommonJS), `bundler` y `node10`. CommonJS con `nodenext` necesita TS ≥5.8, como cualquier paquete solo-ESM.
- `EventEmitter` se importa de `'events'`. En ESM, `import { EventEmitter } from 'stream'` falla: solo funcionaba en CommonJS, por herencia.
- `.prettierrc.js` es ESM (`export default`), porque el paquete es `"type": "module"`.
- `src/nodes7comm.ts` y `src/types/request.types.ts` tienen `/// <reference types="node" preserve="true" />`. No la quites: sin ella, los `.d.ts` publicados pierden la referencia a `@types/node` (TS ≥5.5 ya no la genera).
- La fusión interfaz + clase de `NodeS7Comm` (eventos tipados) tiene `eslint-disable` a propósito; reemplazarla por `EventEmitter<Events>` cambia los tipos públicos.
- `npm audit` reporta avisos solo en `minimatch`, que traen ESLint y typescript-eslint y que todavía no tiene arreglo publicado. Son herramientas de desarrollo y no se publican.

## Convenciones

- Código y comentarios en inglés. Prettier usa 4 espacios, comillas simples, `arrowParens: 'avoid'` y `printWidth: 1200`: las líneas largas son intencionales, no las partas a mano.
- `.prettierrc.js` y `eslint.config.js` son copias exactas de la configuración que el autor usa en sus otros proyectos. Mantenlos iguales a esa fuente: no los ajustes solo para este repo sin preguntar.
- Commits estilo Conventional Commits (`fix:`, `feat:`, `docs:`, `build:`, `release:`).
- Se trabaja en `dev` y se integra en `master`.
- `CHANGELOG.md` se mantiene a mano. Cada cambio se anota en la sección `### Unreleased` (arriba de todo) en el mismo commit que lo introduce, con el prefijo de su tipo (`fix:`, `feat:`...). Lo que rompe compatibilidad va en su `## Breaking Changes`. Al publicar, `Unreleased` se renombra a la versión.
- El próximo release será la **3.0.0**: no habrá ninguna 2.x más. Se permiten cambios incompatibles en la API pública si son intencionales, y cada uno se anota en `## Breaking Changes` de `Unreleased`, porque la v3 necesitará una guía de migración. La API pública son los métodos `initiateConnection`, `readTags`, `writeTags`, `addTags`, `removeTags`, `readAllTags`, `addTranslationTags` y `deleteTranslationTag`, y los eventos `connected`, `connect-timeout`, `disconnected` y `error`.

## Publicación

- `package.json` tiene `"files": ["lib"]`, así que solo se publican `lib/`, README, LICENSE y package.json (ni este archivo ni `test/`).
- No hay `prepublishOnly`: corre `npm run build` antes de `npm publish`, o se publicará un `lib/` viejo.
- `exports` solo expone la raíz del paquete (`types` + `default`), y `engines` pide Node `^20.19.0 || >=22.12.0`. Los dos cambios ya están anotados en `Unreleased` como breaking.
- Antes de publicar, prueba el tarball como lo usaría alguien que lo instala: `npm pack`, instálalo en un proyecto temporal y verifica `import`, `require()` y el type-check con TypeScript.

## nodes7comm
This library allows communication to S7-300/400/1200/1500 PLCs using the Siemens S7 Ethernet protocol RFC1006.

Typescript library based entirely from [nodeS7](https://github.com/plcpeople/nodeS7). With some improvements like the following :

* Promise based, `async/await` support.
* Returns javascript objects with parsed var objects.


## WARNING

This is ALPHA CODE and you need to be aware that WRONG VALUES could be written to WRONG LOCATIONS. Fully test everything you do.

## Usage

```sh
npm install nodes7comm
```
```ts
const { S7Comm } = require('nodes7comm');

// constructor
let s7comm = new S7Comm(<ConnectionConfig>);
s7comm.initiateConnection(); // For now this functions is the only one that not return a promise
```

## Interfaces
 - [ConnectionConfig](#connectionConfig)

<a name="connectionConfig"></a>
### ConnectionConfig

| propertie | type | required | default | description |
|--|--|--|--|--|
|port|number |true| 201 | Port to stablish connection
|host|string |true| 'localhost' | Address to stablish connection
|connectionName|string |false| ```${host} S ${this.slot}``` |
|rack|number |false| 0 |
|slot|number |false| 1 |
|timeout|number |false| 1500 | Time in miliseconds to reject request if this time is exceeded
|silentMode|boolean |false| false | Hidde all messages in console
|localTSAP|number |false| undefined |
|remoteTSAP|number |false| undefined |
|callback|number |false| undefined | 

## nodes7comm

### ⚠️ **Docs in progress**

This library allows communication to S7-300/400/1200/1500 PLCs using the Siemens S7 Ethernet protocol RFC1006.

This library is based entirely from [nodeS7](https://github.com/plcpeople/nodeS7). With some improvements like the following :

* Promise based, `async/await` support.
* Can make concurrent request.

## Atention

You need to be aware that WRONG VALUES could be written to WRONG LOCATIONS. Fully test everything you do.

## Usage

```sh
npm install nodes7comm
```
```ts
const { S7Comm } = require('nodes7comm');

let s7comm = new S7Comm(<ConnectionConfig>);
s7comm.initiateConnection(); // For now this functions is the only one that not return a promise
```
## Data Types

| Type | Prefix |  Examples  |
| ------------ | ------------ | ------------ |
|  Boolean |  X or nothing | DB.1,X3.0 Q0.2 M23.0 |
|  Int |  INT  |  MINT30 DB2,INT124 |



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

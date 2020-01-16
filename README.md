

## nodes7comm

This library allows communication to S7-300/400/1200/1500 PLCs using the Siemens S7 Ethernet protocol.

This library is based entirely from [nodeS7](https://github.com/plcpeople/nodeS7). With some improvements like the following :

* Promise based, `async/await` support.
* Can make concurrent request.
* Definition file for TypeScript

## Atention

You need to be aware that WRONG VALUES could be written to WRONG LOCATIONS. Fully test everything you do.
This library has been tested only in S7-1200 and S7-1500 but this library should work for S7-300 and S7-400.

## Get Started
* First you need to enable Enable GET/PUT Access in TIA Portal.  
* For access to a DB you must disable Optimized Block Access in TIA Portal for that DB.

More info: [snap7](http://snap7.sourceforge.net/snap7_client.html)
```sh
npm install nodes7comm
```

## Methods

- [initiateConnection()](#InitiateConnecton)
- [readItems()](#readItems)
- [writeItems()](#writeItems)

<a  name="initiateConnection">InitiateConnecton</a>
```ts
const { S7Comm } = require('nodes7comm');

let  s7comm = new  S7Comm(<ConnectionConfig>);
s7comm.initiateConnection();
```

### ConnectionConfig: Object

| propertie | type | required | default | description |
|--|--|--|--|--|
|port|number |true| 201 | Port to stablish connection
|host|string |true|  | Address to stablish connection
|connectionName|string |false| ```${host} S${slot}``` | |
|rack|number |false| 0 | |
|slot|number |false| 1 | |
|timeout|number |false| 1500 | Time in miliseconds to reject request if this time is exceeded
|silentMode|boolean |false| false | Hidde all messages in console
|localTSAP|number |false| undefined | |
|remoteTSAP|number |false| undefined | |
|callback|number |false| undefined | |

<a  name="readItems"> readItems()</a>
```ts
// This function read values in given plc directions
s7comm.readItems(['DB1,REAL2', 'M0.0']).then((values) => {
	console.log(values); // { 'DB1,REAL2': 20.0, 'M0.0': false }
});
```
<a  name="writeItems">writeItems()</a>

```ts

// This function write values in given plc directions
// Arrays must have same length
s7comm.writeItems(['MREAL2', 'DB1,INT0', 'DB1,REAL2', 'DB1,S6.4'], [4.4, 100, 32.3, 'Hello' ]).then((writen) => {
	if(writen) {
		// All fine
	} else {
		// Something wrong
	}
});
```
### AND MORE COMMING SOON...
If you have an **issue** or any **question** please feel free to open a issue.


## Data Types
| Type | Prefix | Examples |
| - | - | - |
| boolean | X or nothing | DB.1,X3.0 <br> Q0.0 <br> Q0.2 <br> I0.0 <br> M23.0 |
| int | INT | MINT30 <br> DB2,INT124 |
| double int | DINT | MDINT30 <br> DB2,DINT2 |
| real | REAL | MREAL30 <br> DB2,REAL120 |
| string | S | DB.1,S30.6 (string of 6 bytes) |

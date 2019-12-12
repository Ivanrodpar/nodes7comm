
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

let  s7comm = new  S7Comm(<ConnectionConfig>);
s7comm.initiateConnection();

// This function read values in given plc directions
s7comm.readItems(['DB1,REAL2', 'M0.0']).then((values) => {
	console.log(values); // { 'DB1,REAL2': 20.0, 'M0.0': false }
});

// This function write values in given plc directions
s7comm.writeItems(['MREAL2', 'DB1,INT0', 'DB1,REAL2', 'DB1,S6.4'], [4.4, 100, 32.3, 'Hello' ]).then((writen) => {
	if(writen) {
		// All fine
	} else {
		// something wrong
	}
});
```

## Data Types
| Type | Prefix | Examples |
| - | - | - |
| boolean | X or nothing | DB.1,X3.0 <br> Q0.0 <br> Q0.2 <br> I0.0 <br> M23.0 |
| int | INT | MINT30 <br> DB2,INT124 |
| double int | DINT | MDINT30 <br> DB2,DINT2 |
| real | REAL | MREAL30 <br> DB2,REAL120 |

## Interfaces

- [ConnectionConfig](#connectionConfig)

<a  name="connectionConfig"></a>

### ConnectionConfig

  

| propertie | type | required | default | description |
|--|--|--|--|--|
|port|number |true| 201 | Port to stablish connection
|host|string |true|  | Address to stablish connection
|connectionName|string |false| ```${host} S ${this.slot}``` |
|rack|number |false| 0 |
|slot|number |false| 1 |
|timeout|number |false| 1500 | Time in miliseconds to reject request if this time is exceeded
|silentMode|boolean |false| false | Hidde all messages in console
|localTSAP|number |false| undefined |
|remoteTSAP|number |false| undefined |
|callback|number |false| undefined |
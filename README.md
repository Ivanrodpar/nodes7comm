

## nodes7comm

This library allows communication to S7-300/400/1200/1500 PLCs using the Siemens S7 Ethernet protocol.

This library is based entirely from [nodeS7](https://github.com/plcpeople/nodeS7).

## Get Started
* First you need to enable GET/PUT Access. Right click on PLC -> Properties -> Protection and security -> Connections mechanisms -> Check GET/PUT Access. 
* For access to a DB you must disable Optimized Block Access in TIA Portal for that DB. Right click on DB -> Properties -> Attributes -> Uncheck Optimized Block Access.
* More info: [snap7](http://snap7.sourceforge.net/snap7_client.html)

## Installation
```sh
npm install nodes7comm
```

## Methods

- [initiateConnection](#initiateConnecton)
- [readTags](#readTags)
- [writeTags](#writeTags)
- [addTranslationTags](#addTranslationTags)
- [deleteTranslationTag](#deleteTranslationTag)
- [addTags](#addTags)
- [readAllTags](#readAllTags)
- [removeTags](#removeTags)

<a  name="initiateConnection">initiateConnecton</a>

```ts

import { NodeS7Comm, Nodes7CommConfig } from 'nodes7comm';

const options: Nodes7CommConfig = {
    host: '192.168.1.200',
};

const s7Client = new NodeS7Comm(options);
s7Client.initiateConnection();

s7Client.on('error', (err) => {
	// Error events
});

s7Client.on('disconnected', () => {
	// When we are reading or writing and a timeout ocurred
});

s7Client.on('connected', () => {
	// When we connect to the PLC
});

s7Client.on('connect-timeout', () => {
	// When we are unable to establish a connection
});

```

### Nodes7CommConfig: Interface

| propertie | type | required | default | description |
|-|-|-|-|-|
|host|string |true|  | Address of the PLC|
|port|number |false| 102 | Port to stablish connection|
|rack|number |false| 0 | Rack of PLC |
|slot|number |false| 1 | Slot of PLC |
|connectionTimeout|number |false| 5000 | Timeout to establish a connection |
|requestTimeout|number |false| 1500 | Timeout of each request |
|localTSAP|number |false|  |  |
|remoteTSAP|number |false|  |  |
|connectionName|string |false| ```${host}``` | |
|optimize|boolean |false| true | Enable optimization of packages sent to PLC |
|autoReconnect|boolean |false| true | Auto connect after disconnect |
|logLevel| 'none' <br> 'error' <br> 'warn' <br> 'info' | false | 'none' | Show logs in console|


<a name="readTags">readTags</a> 

```ts

// This function read values in given plc directions
s7Client.readTags('Q0.0').then((value) => {
	console.log(value); // { 'Q0.0': false }
});

s7Client.readTags(['DB100,REAL22', 'M0.0']).then((values) => {
	console.log(values); // { 'DB100,REAL22': 20.5, 'M0.0': false }
});

```
<a name="writeTags">writeTags</a>

```ts

// This function write values in given plc directions
s7Client.writeTags('Q0.0', false).then((newValues) => {
	console.log(newValues); // { 'Q0.0': false }
});

// Arrays must have same length
s7Client.writeTags(['DB100,REAL22', 'DB99,S0.50'], [32.3, 'Hello' ]).then((newValues) => {
	console.log(newValues); // { 'DB100,REAL22': 32.3, 'DB99,S0.50': 'Hello' }
});

```
<a name="addTranslationTags">addTranslationTags</a>

```ts

// This function add a name to each directions, for better manage for your app

const tags = {
    analog: 'DB100,REAL22',
    name: 'DB99,S0.50',
    output: 'Q0.0',
};

s7Client.addTranslationTags(tags);

// Note that this time we are reading the keys of the above object
s7Client.readTags(['analog', 'name', 'output']).then((values) => {
	console.log(values); // { analog: 32.29999923706055, name: 'Hello', output: true }
});

const moreTags = {
    active: 'DB100,X0.0',
};

s7Client.addTranslationTags(moreTags);

// Apply on writeTags() too
s7Client.writeTags(['analog', 'active'], [50.5, true]).then((values) => {
    console.log(values); // { analog: 50.5, active: true }
});

```

<a name="deleteTranslationTag">deleteTranslationTag</a> 

```ts

// Delete a tag from translation object
s7Client.deleteTranslationTag('analog');

s7Client.readTags('analog').then((values) => {
    console.log(values);
}).catch(err => {
    console.log(err); // Failed to find a match for: analog
});

```


<a name="addTags">addTags</a> 

```ts

// We can save tags in the instance for read all stored tags
s7Client.addTags(['DB100,X0.0']);

const tags = {
    input: 'I0.0',
    tagBool: 'M6.4',
};
s7Client.addTranslationTags(tags); // If we want to store alias, we need first add these tags in the traslation

s7Client.addTags(Object.keys(tags)); // Array of tags


```


<a name="readAllTags">readAllTags</a> 

```ts

const tags = {
    input: 'I0.0',
    tagBool: 'M6.4',
};
s7Client.addTranslationTags(tags);

// Add he keys of the abject above
s7Client.addTags(Object.keys(tags));

s7Client.readAllTags().then((values) => {
    console.log(values); // { input: false, tagBool: false }
});

```


<a name="removeTags">removeTags</a> 

```ts

// Remove tags from the instance
s7Client.removeTags('input');

s7Client.readAllTags().then((values) => {
    console.log(values); // { tagBool: false }
});


```


## Supported address
| Operand identifier | Data type | Examples |
|-|-|-|
| Input (I) | Bool <br> Byte <br> Char <br> Word <br> Int <br> DWord <br> DInt <br> Real <br> LReal | I1.0 <br> IB3 <br> IC4 <br> IW22 <br> II24 <br> ID26 <br> ID140 <br> IR1400 <br> ILR1404 |
| Output (Q) | Bool <br> Byte <br> Char <br> Word <br> Int <br> DWord <br> DInt <br> Real <br> LReal | Q0.2 <br> QB2 <br> QC4 <br> QW20 <br> QI22 <br> QD24 <br> QDI28 <br> QR32 <br> QLR36 |
| Memory (M) | Bool <br> Byte <br> Char <br> Word <br> Int <br> DWord <br> DInt <br> Real <br> LReal | M2.2 <br> MB0 <br> MC2 <br> MW220 <br> MI28 <br> MD40 <br> MD100 <br> MR2000 <br> MLR2004 |
| Data Block (DB) | Bool <br> Byte <br> Char <br> Word <br> Int <br> DWord <br> DInt <br> Real <br> LReal <br> String | DB5,X2.2 <br> DB6,B0 <br> DB10,C2 <br> DB10,W220 <br> DB10,I28 <br> DB12,D40 <br> DB2,D100 <br> DB100,R2 <br> DB101,LR6 <br> DB99,S0.50 |

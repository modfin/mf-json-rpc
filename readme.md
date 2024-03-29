# MF JSON RPC

### Install

```
npm i @modfin/mf-json-rpc
```

### Call (standard request/response)

```javascript
import { Rpc } from '@modfin/mf-json-rpc'

const client = new Rpc({ uri: 'ws://localhost:7357' })
// (don't need to wait for any connection to be established, it's handled internally)
const res = await client.call('method', { optional: 'params' })
```

### Stream 

TODO: maybe expose a generator or some fancy cycle.js stream, but is a simple callback for now

```javascript
import { Rpc } from '@modfin/mf-json-rpc'

const client = new Rpc({ uri: 'ws://localhost:7357' })
let updates = []
client.stream('method_with_stream_support', { optional: 'params' }, update => {
    updates = [...updates, update]
})
```

### Options

```javascript
const client = new Rpc({ uri: 'ws://localhost:7357' })
const res = await client.call(
    'method',
    { optional: 'params' },
    { headers: { Authorization: authToken } }
)
client.stream(
    'method_with_stream_support',
    { optional: 'params' },
    update => { updates = [...updates, update] },
    { headers: { Authorization: authToken } }
)
```

### Typescript support

Some methods have a template parameter to indicate the expected shape of e.g. a result:

```Typescript
interface ComplexType { s: string, n: number, nested: { a: (number | string)[] } }
const complexResponse: MFJsonRpcResponse<ComplexType> = await client.call<ComplexType>('complex-method')
const complexResult: ComplexType = complexResponse.result
```

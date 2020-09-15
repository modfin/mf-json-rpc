# MF JSON RPC

### Install

```
npm i mf-json-rpc
```

### Call (standard request/response)

```javascript
import { Rpc } from 'mf-json-rpc'

const client = new Rpc({ uri: 'ws://localhost:7357' })
// (don't need to wait for any connection to be established, it's handled internally)
const res = await client.call('method', { optional: 'params' })
```

### Stream 

TODO: maybe expose a generator or some fancy cycle.js stream, but is a simple callback for now

```javascript
import { Rpc } from 'mf-json-rpc'

const client = new Rpc({ uri: 'ws://localhost:7357' })
let updates = []
client.stream('method_with_stream_support', { optional: 'params' }, update => {
    updates = [...updates, update]
})
```

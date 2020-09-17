import { Rpc, MFJsonRpcAction, MFJsonRpcReply, ProtocolError } from './index'
import MockWS from "jest-websocket-mock";

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('should make a successful call request', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    client.call('test')

    const m = await server.nextMessage;
    expect(m).toMatchObject({
        jsonrpc: '2.0',
        type: 'CALL',
        method: 'test',
        params: {}
    })

    client.dispose();
    return MockWS.clean();
})

test('should fail invalid call request', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const res = client.call('test')

    const cm = await server.nextMessage as MFJsonRpcAction;
    server.send({
        jobId: cm.jobId,
        result: null,
        error: {
            code: Rpc.ErrorCodes.METHOD_NOT_FOUND,
            message: 'method not found'
        }
    } as MFJsonRpcReply)

    await res.catch((e) => { expect(e).toBeInstanceOf(ProtocolError) })

    client.dispose();
    return MockWS.clean();
})

test('should support header field in call', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    client.call('test', {}, { headers: { 'TestHeaderKey': 'TestHeaderValue' } })

    const m = await server.nextMessage;
    expect(m).toMatchObject({
        jsonrpc: '2.0',
        type: 'CALL',
        method: 'test',
        params: {},
        header: { 'TestHeaderKey': 'TestHeaderValue' }
    })

    client.dispose();
    return MockWS.clean();
})

test('should handle call request response', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const res = client.call('test')

    const cm = await server.nextMessage as MFJsonRpcAction;
    expect(cm).toMatchObject({
        jsonrpc: '2.0',
        type: 'CALL',
        method: 'test',
        params: {}
    })
    server.send({ jobId: cm.jobId, result: 'res' } as MFJsonRpcReply)

    const sm = await res
    expect(sm).toMatchObject({ jobId: cm.jobId, result: 'res' })

    client.dispose();
    return MockWS.clean();
})

test('should handle multiple call requests', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const res0 = client.call('echo0')
    const res1 = client.call('echo1')

    const cm0 = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: cm0.jobId, result: cm0.method } as MFJsonRpcReply)
    const cm1 = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: cm1.jobId, result: cm1.method } as MFJsonRpcReply)

    const sm0 = await res0
    expect(sm0).toMatchObject({ jobId: cm0.jobId, result: 'echo0' })
    const sm1 = await res1
    expect(sm1).toMatchObject({ jobId: cm1.jobId, result: 'echo1' })

    client.dispose();
    return MockWS.clean();
})

test('should make a successful call request with parameters', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const p = { s: 's', n: 1, a: ['a', 1], o: { p: 1 } }
    client.call('test', p)

    const m = await server.nextMessage;
    expect(m).toMatchObject({
        jsonrpc: '2.0',
        type: 'CALL',
        method: 'test',
        params: p
    })

    client.dispose();
    return MockWS.clean();
})

test('should make a successful stream subscription', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const streamResp = client.stream('test', {}, () => { })

    const m = await server.nextMessage as MFJsonRpcAction;
    expect(m).toMatchObject({
        jsonrpc: '2.0',
        type: 'STREAM',
        method: 'test',
        params: {}
    })
    server.send({ jobId: m.jobId, result: 'successful stream subscription', header: {} })

    const id = await streamResp
    expect(id).toEqual(m.jobId)

    client.dispose();
    return MockWS.clean();
})

test('should support header field in stream', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const streamResp = client.stream('test', {}, () => { }, { headers: { 'TestHeaderKey': 'TestHeaderValue' } })

    const m = await server.nextMessage as MFJsonRpcAction;
    expect(m).toMatchObject({
        jsonrpc: '2.0',
        type: 'STREAM',
        method: 'test',
        params: {},
        header: { 'TestHeaderKey': 'TestHeaderValue' }
    })
    server.send({ jobId: m.jobId, result: 'successful stream subscription', header: {} })

    const id = await streamResp
    expect(id).toEqual(m.jobId)

    client.dispose();
    return MockWS.clean();
})

test('should setup multiple stream subscriptions', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const streamResp0 = client.stream('test0', {}, () => { })
    const streamResp1 = client.stream('test1', {}, () => { })

    const m0 = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: m0.jobId, result: 'successful stream subscription', header: {} })
    const m1 = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: m1.jobId, result: 'successful stream subscription', header: {} })

    const id0 = await streamResp0
    expect(id0).toEqual(m0.jobId)
    const id1 = await streamResp1
    expect(id1).toEqual(m1.jobId)

    expect(id0).not.toEqual(id1)

    client.dispose();
    return MockWS.clean();
})

test('should reuse stream subscription id', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const streamResp0 = client.stream('test', {}, () => { })
    const streamResp1 = client.stream('test', {}, () => { })

    const m0 = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: m0.jobId, result: 'successful stream subscription', header: {} })
    const m1 = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: m1.jobId, result: 'successful stream subscription', header: {} })

    const id0 = await streamResp0
    const id1 = await streamResp1

    expect(id0).toEqual(id1)

    client.dispose();
    return MockWS.clean();
})

test('should publish stream update', async () => {
    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const streamUpdate = new Promise(r => {
        client.stream('test', {}, update => {
            r(update)
        })
    })

    const m = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: m.jobId, result: 'successful stream subscription', header: {} })

    await delay(300)

    server.send({ jobId: m.jobId, result: 'update', header: {} })

    const updateMessage = await streamUpdate
    expect(updateMessage).toEqual('update')

    client.dispose();
    return MockWS.clean();
})

test('should reconnect after server down', async () => {
    jest.setTimeout(10000)

    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    server.close();

    await delay(1300)

    const server2 = new MockWS('ws://localhost:7357', { jsonProtocol: true })

    client.call('test')

    const m = await server2.nextMessage;
    expect(m).toMatchObject({
        jsonrpc: '2.0',
        type: 'CALL',
        method: 'test',
        params: {}
    })

    client.dispose();
    return MockWS.clean();
})

test('should resubscribe after server down', async () => {
    jest.setTimeout(10000)

    const server = new MockWS('ws://localhost:7357', { jsonProtocol: true })
    const client = new Rpc({ uri: 'ws://localhost:7357' })

    const streamUpdate = new Promise(r => {
        client.stream('test', {}, update => {
            r(update)
        })
    })

    const m = await server.nextMessage as MFJsonRpcAction;
    server.send({ jobId: m.jobId, result: 'successful stream subscription', header: {} })

    server.close()

    await delay(1300)

    const server2 = new MockWS('ws://localhost:7357', { jsonProtocol: true })

    const m2 = await server2.nextMessage as MFJsonRpcAction;
    server.send({ jobId: m2.jobId, result: 'successful stream subscription', header: {} })

    await delay(300)

    server2.send({ jobId: m.jobId, result: 'update', header: {} })

    const updateMessage = await streamUpdate
    expect(updateMessage).toEqual('update')

    client.dispose();
    return MockWS.clean();
})

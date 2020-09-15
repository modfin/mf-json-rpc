export class Rpc {
    public static readonly DefaultConnectionTimeoutMs = 3000;
    public static readonly DefaultMessageTimeoutMs = 1500;
    public static readonly HeartbeatIntervalMs = 1234;
    public static readonly ConnectionBackoffExponent = 2;
    public static readonly ErrorCodes: { [errorName: string]: RpcErrorCode } = {
        PARSE_ERROR: -32700,
        INVALID_REQUEST: -32600,
        METHOD_NOT_FOUND: -32601,
        INVALID_PARAMS: -32602,
        INTERNAL_ERROR: -32603,
        // note @jonas: custom error code documented in the old rpc client,
        // but does not seem to be used in the server implementation
        CLOSING_DUE_TO_TOO_MANY_ERRORS: 4000,
    }

    private uri: string;
    private connectionTimeoutMs: number;

    // TODO @jonas: retries
    private messageTimeoutMs: number;

    private inFlightRequests: { [requestId: string]: RequestResolver } = {};
    private subscribers: { [topic: string]: Subscriber } = {};

    // TODO @jonas: heartbeat
    private latencyMs = 0;
    
    private ws: WebSocket | undefined;

    private _isDisposed = false;
    private readonly _sessionId = uuidV4();

    constructor({
        uri,
        connectionTimeoutMs = Rpc.DefaultConnectionTimeoutMs,
        messageTimeoutMs = Rpc.DefaultMessageTimeoutMs
    }: {
        uri: string
        connectionTimeoutMs?: number
        messageTimeoutMs?: number
    }) {
        if (typeof uri !== 'string' || !uri) {
            throw new TypeError(NO_URI_ERROR)
        }

        const protocolRx = /^.*:\/\//
        const wsProtocol = window && window.location.protocol === 'https:'
            ? 'wss://'
            : 'ws://';

        this.uri = uri.match(protocolRx)
            ? uri.replace(protocolRx, wsProtocol)
            : `${wsProtocol}${uri}`;

        this.connectionTimeoutMs = connectionTimeoutMs;
        this.messageTimeoutMs = messageTimeoutMs;
    }

    /**
     * Public interface
     */

    public send = (() => {
        let usedCustomIds = new Set<UUIDV4>();
        return async (
            type: "CALL" | "STREAM",
            method: string,
            params?: { [key: string]: JsonValue },
            customId?: string
        ) => {
            if (this._isDisposed) {
                throw new ConnectionError("This Rpc has been disposed, create a new one to send messages");
            }

            if (!!customId) {
                if (isUuidV4(customId)) {
                    throw new TypeError("customId must be a valid uuidV4 if supplied")
                }
                if (this.inFlightRequests[customId]) {
                    throw new TransportError("customId cannot equal an already in-flight request id");
                }

                usedCustomIds.add(customId);
            }

            let nextId = uuidV4();
            while (usedCustomIds.has(nextId)) {
                nextId = uuidV4();
            }
            const requestId = !!customId
                ? customId
                : nextId;

            const msg: MFJsonRpcRequest = {
                jsonrpc: "2.0",
                type: type,
                method: method,
                jobId: requestId,
                params: params ?? {},
                header: { sessionId: this._sessionId }
            };
            const jsonMsg = JSON.stringify(msg) // will also throw, but has well typed error

            try {
                const ws = await this.connect();
                ws.send(jsonMsg);
            } catch (e) {
                throw new ConnectionError(`could not connect to send msg = ${jsonMsg}, error: ${e}`)
            }

            return new Promise<MFJsonRpcResponse>((resolve, reject) => {
                this.inFlightRequests[requestId] = {
                    resolve: payload => {
                        delete this.inFlightRequests[requestId];
                        resolve(payload);
                    },
                    reject: payload => {
                        delete this.inFlightRequests[requestId];
                        reject(payload);
                    }
                }
            });
        }
    })();

    public call = (method: string, params: { [key: string]: JsonValue } = {}) =>
        this.send("CALL", method, params)

    public stream = async (method: string, params: { [key: string]: JsonValue }, callback: (value: JsonValue) => void) => {
        const topic = `${method}_${JSON.stringify(params)}`
        if (!this.subscribers[topic]) {
            const res = await this.send("STREAM", method, params)
            // bit of a special race condition case here
            // looks ugly but I think it's better than alternatives
            if (!this.subscribers[topic]) {
                this.subscribers[topic] = {
                    callbacks: [],
                    id: res instanceof Array
                        ? res[0].jobId
                        : res.jobId,
                    params: params
                }
            }
        }

        if (!this.subscribers[topic].callbacks.includes(callback)) {
            this.subscribers[topic].callbacks.push(callback);
        }

        return this.subscribers[topic].id
    }

    /**
     * Private
     */

    private connect = (() => {
        let currentConnectionPromise: Promise<WebSocket> | undefined = undefined;
        return () => {
            if (!currentConnectionPromise) {
                currentConnectionPromise = new Promise((resolve, reject) => {
                    if (!this.ws
                        || (this.ws.readyState !== WebSocket.OPEN
                            && this.ws.readyState !== WebSocket.CONNECTING)
                    ) {
                        this.ws = new WebSocket(this.uri);
                        this.ws.onerror = event =>
                            reject(new ConnectionError(`Could not connect to server, error event ${event}`));
                        this.ws.onmessage = this.getMessageHandler();
                        this.ws.onopen = () => {
                            currentConnectionPromise = undefined;
                            this.resubscribe();
                            resolve(this.ws);
                        };

                        setTimeout(() => {
                            currentConnectionPromise = undefined;
                            reject(new ConnectionError(`connection to ${this.uri} timed out`));
                        }, this.connectionTimeoutMs);
                    } else {
                        setTimeout(() => {
                            currentConnectionPromise = undefined;
                            resolve(this.ws);
                        }, 0);
                    }
                });
            }
            return currentConnectionPromise;
        }
    })();

    private getMessageHandler = () => {
        return (event: MessageEvent) => {
            try {
                const rawMessage = JSON.parse(event.data) as MFJsonRpcResponse;
                const batchedMessages = rawMessage instanceof Array ? rawMessage : [rawMessage];
                batchedMessages.forEach(message => {
                    if (message.error) {
                        if (this.inFlightRequests[message.jobId]) {
                            const err = new ProtocolError(message.error.message, message.error.code)
                            this.inFlightRequests[message.jobId].reject(err);
                        } else {
                            console.error(`received erroneous rpc message, message = ${event.data}`);
                        }
                    } else if (message.hasOwnProperty('result')) {
                        if (this.inFlightRequests[message.jobId]) {
                            this.inFlightRequests[message.jobId].resolve(message)
                        } else {
                            this.notify(message.jobId, message.result);
                        }
                    } else {
                        throw new ProtocolError(`Message does not seem to follow protocol, message = ${message}`, Rpc.ErrorCodes.INTERNAL_ERROR);
                    }
                })
            } catch (e) {
                console.error(`Rpc could not handle incoming message = ${event}, error = ${e}`);
            }
        }
    }

    private notify = (subscriptionId: string, message: JsonValue) => {
        Object.values(this.subscribers)
            .filter(sub => sub.id === subscriptionId)
            .forEach(sub => sub.callbacks.forEach(f => f(message)));
    }

    private resubscribe = () => {
        Object.entries(this.subscribers).forEach(([method, sub]) => {
            this.send("STREAM", method, sub.params ?? {}, sub.id);
        })
    }
}


type UUIDV4 = string

// Note @jonas: from https://stackoverflow.com/questions/105034/how-to-create-guid-uuid
// also note the low-quality random used. is okay for this use case however
const uuidV4 = (): UUIDV4 => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    .replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0
        const v = c == 'x'
            ? r
            : (r & 0x3 | 0x8);
        return v.toString(16);
    });

const isUuidV4 = (x: any): x is UUIDV4 =>
    typeof x === 'string'
    && !!x.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

/**
 * Types
 */

type RpcErrorCode = number;

type JsonValue = string | number | null | { [key: string]: JsonValue } | JsonValue[]

interface RequestResolver {
    resolve: (payload: MFJsonRpcResponse) => void
    reject: (err: Error) => void
}

interface Subscriber {
    id: string,
    params: { [key: string]: JsonValue },
    callbacks: ((value: JsonValue) => void)[]
}

export interface MFJsonRpcAction {
    jsonrpc: "2.0",
    jobId: string,
    type: "CALL" | "STREAM",
    method: string,
    params: { [key: string]: JsonValue }
    header?: { [key: string]: string }
}
type MFJsonRpcRequest = MFJsonRpcAction | MFJsonRpcAction[]

interface MFJsonRpcError {
    code: RpcErrorCode
    message: string
    data: JsonValue
}
export interface MFJsonRpcReply {
    // note @jonas: server implementation is missing `jsonrpc: '2.0'` param

    jobId: "d2f9d3b9-ff76-4881-be45-573aa206418f",
    result: JsonValue,

    // note @jonas: server wsrpc implementation states that these should be equivalent to
    // HTTP headers, i.e. { [key:string]: string }, but then defines a map with type erased values
    // https://github.com/modfin/wsrpc/blob/master/header.go#L7-L8. So that's what we're replicating below:
    header: { [key: string]: JsonValue },

    error: MFJsonRpcError
}
type MFJsonRpcResponse = MFJsonRpcReply | MFJsonRpcReply[]

export class ConnectionError extends Error {
    constructor(msg: string) {
        super(msg);
        Object.setPrototypeOf(this, ConnectionError.prototype);
    }
}

export class TransportError extends Error {
    constructor(msg: string) {
        super(msg);
        Object.setPrototypeOf(this, TransportError.prototype);
    }
}

export class ProtocolError extends Error {
    private code: RpcErrorCode;
    constructor(msg: string, code = Rpc.ErrorCodes.INTERNAL_ERROR) {
        super(msg);
        this.code = code;
        Object.setPrototypeOf(this, ProtocolError.prototype);
    }
}

const NO_URI_ERROR = `
Rpc needs an uri to connect to as part of it's opts
Constructor arguments are:
{
    uri: string,
    connectionTimeoutMs?: number,
    messageTimeoutMs?: number
}

Examples:
    1. new Rpc({ uri: "api.monitor.holdings.se/proxy/irma-v2/irma/ops/ws" })
    2. new Rpc({
            uri: "wss://api.monitor.holdings.se/proxy/irma-v2/irma/ops/ws",
            connectionTimeoutMs: 2000
       })
    3. new Rpc({
            uri: "http://api.monitor.holdings.se/proxy/irma-v2/irma/ops/ws",
            messageTimeoutMs: 500
       })
    4. new Rpc({ uri: "whatever://api.monitor.holdings.se/proxy/irma-v2/irma/ops/ws" })

Note that the protocol of the uri does not matter, it will be replaced with "ws://" or "wss://"
`

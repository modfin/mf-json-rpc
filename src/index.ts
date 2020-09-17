const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export class Rpc {
    public static readonly DefaultConnectionTimeoutMs = 1618;
    public static readonly DefaultMessageTimeoutMs = 1500;
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

        const heartbeat = (() => {
            let nextTimeout = Rpc.DefaultConnectionTimeoutMs;
            return async () => {
                for (; ;) {
                    if (this._isDisposed) {
                        break
                    }
                    try {
                        await this.connect();
                        // rest timeout on successful connection
                        nextTimeout = Rpc.DefaultConnectionTimeoutMs;
                    } catch (e) {
                        if (e instanceof ConnectionError) {
                            nextTimeout = Rpc.ConnectionBackoffExponent * nextTimeout;
                        }
                    }
                    await delay(nextTimeout);
                }
            }
        })();
        heartbeat();

        // TODO @jonas: some bug in firefox needs this workaround?
        window.addEventListener('beforeunload', () => this.ws && this.ws.close());
    }

    /**
     * Public interface
     */

    public send = (() => {
        let usedCustomIds = new Set<UUIDV4>();
        return async (
            type: "CALL" | "STREAM",
            method: string,
            opts: {
                params?: { [key: string]: JsonValue },
                headers?: { [key: string]: string },
                customId?: string
            } = {}
        ) => {
            if (this._isDisposed) {
                throw new ConnectionError("This Rpc has been disposed, create a new one to send messages");
            }

            if (!!opts.customId) {
                if (!isUuidV4(opts.customId)) {
                    throw new TypeError("opts.customId must be a valid uuidV4 if supplied")
                }
                if (this.inFlightRequests[opts.customId]) {
                    throw new TransportError("opts.customId cannot equal an already in-flight request id");
                }
                usedCustomIds.add(opts.customId);
            }

            let nextId = uuidV4();
            while (usedCustomIds.has(nextId)) {
                nextId = uuidV4();
            }

            const requestId = !!opts.customId
                ? opts.customId
                : nextId;

            const msg: MFJsonRpcRequest = {
                jsonrpc: "2.0",
                type: type,
                method: method,
                jobId: requestId,
                params: opts.params ?? {},
                header: {
                    sessionId: this._sessionId,
                    ...(opts.headers || {})
                }
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

    public call = (method: string, params: { [key: string]: JsonValue } = {}, options?: { headers?: { [key: string]: string } }) =>
        this.send("CALL", method, { params, headers: options?.headers })

    public stream = async (
        method: string,
        params: { [key: string]: JsonValue },
        callback: (value: JsonValue) => void,
        options?: { headers?: { [key: string]: string } }
    ): Promise<UUIDV4> => {
        const topic = `${method}_${JSON.stringify(params)}`
        if (!this.subscribers[topic]) {
            const res = await this.send("STREAM", method, { params, headers: options?.headers })
            // bit of a special race condition case here
            // looks ugly but I think it's better than alternatives
            if (!this.subscribers[topic]) {
                this.subscribers[topic] = {
                    method: method,
                    callbacks: [],
                    id: res instanceof Array
                        ? res[0].jobId
                        : res.jobId,
                    params: params,
                    options: options
                }
            }
        }

        if (!this.subscribers[topic].callbacks.includes(callback)) {
            this.subscribers[topic].callbacks.push(callback);
        }

        return this.subscribers[topic].id
    }

    public dispose = () => {
        this._isDisposed = true;
        this.ws?.close(1000, "user closed connection");
    };

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
                        this.ws.onclose = () => {
                            this.ws?.close(1000, 'remote socket closed')
                        }

                        setTimeout(() => {
                            currentConnectionPromise = undefined;
                            if (!this.ws || this.ws.readyState === WebSocket.CONNECTING) {
                                this.ws = undefined;
                                reject(new ConnectionError(`connection to ${this.uri} timed out`));
                            }
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
                            // TODO @jonas: may want to handle subscription fail/finish callback
                            // differently in the future
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
        Object.values(this.subscribers).forEach((sub) => {
            this.send(
                "STREAM",
                sub.method, {
                params: sub.params,
                headers: sub.options?.headers,
                customId: sub.id
            });
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
    method: string,
    params: { [key: string]: JsonValue },
    callbacks: ((value: JsonValue) => void)[],
    options?: {
        headers?: { [key: string]: string }
    }
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
export type MFJsonRpcResponse = MFJsonRpcReply | MFJsonRpcReply[]

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

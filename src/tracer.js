const uuid = require('uuid');
const uuidParse = require('uuid-parse');

function UUIDToHex(id) {
    const uuidBuffer = Buffer.alloc(16);
    uuidParse.parse(id, uuidBuffer);
    return uuidBuffer.toString('hex');
}

const convertHeaders = (from, redacted) => {
    const to = {};
    for (let [key, value] of from.entries()) {
        key = key.toLowerCase();
        to[key] = redacted.includes(key) ? 'REDACTED' : value;
    }
    return to;
};

class Span {
    constructor(init, config) {
        this.config = config;
        this.data = {};
        this.childSpans = [];
        this.eventMeta = {
            timestamp: Date.now(),
            name: init.name,
            trace: init.trace_context,
            service_name: init.service_name,
        };
    }

    parseToEvents() {
        const event = Object.assign({}, this.data, this.eventMeta);
        const childEvents = this.childSpans.map(span => span.parseToEvents()).flat(1);
        return [event, ...childEvents];
    }

    addData(data) {
        Object.assign(this.data, data);
    }

    addRequest(request) {
        this.request = request;
        if (!request) return;

        const json = {
            headers: request.headers ?
                convertHeaders(request.headers, this.config.redactRequestHeaders) : undefined,
            method: request.method,
            redirect: request.redirect,
            referrer: request.referrer,
            referrerPolicy: request.referrerPolicy,
            url: request.url,
        };
        this.addData({ request: json });
    }

    addResponse(response, body) {
        this.response = response;
        if (!response) return;
        const json = {
            headers: response.headers ?
                convertHeaders(response.headers, this.config.redactResponseHeaders) : undefined,
            ok: response.ok,
            redirected: response.redirected,
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            body,
        };
        this.addData({ response: json });
    }

    log(message) {
        this.data.logs = this.data.logs || [];
        this.data.logs.push(message);
    }

    start() {
        this.eventMeta.timestamp = Date.now();
    }

    finish() {
        this.eventMeta.duration_ms = Date.now() - this.eventMeta.timestamp;
    }

    fetch(input, init) {
        const request = new Request(input, init);
        const childSpan = this.startChildSpan(request.url, 'fetch');
        childSpan.addRequest(request);
        const promise = fetch(request);
        promise
            .then((response) => {
                const clonedResponse = response.clone();
                let responseBody;
                const contentType = clonedResponse.headers.get('content-type');
                if (contentType && contentType.indexOf('application/json') !== -1) {
                    clonedResponse.json().then((data) => {
                        responseBody = data;
                        childSpan.addResponse(response, responseBody);
                        childSpan.finish();
                    });
                }
                if (contentType && contentType.indexOf('text/plain;charset=UTF-8') !== -1) {
                    clonedResponse.json().then((data) => {
                        responseBody = data;
                        childSpan.addResponse(response, responseBody);
                        childSpan.finish();
                    });
                } else {
                    childSpan.addResponse(response, responseBody);
                    childSpan.finish();
                }
            })
            .catch((reason) => {
                childSpan.addData({ exception: reason });
                childSpan.finish();
            });
        return promise;
    }

    startChildSpan(name, serviceName) {
        const trace = this.eventMeta.trace;
        const service_name = serviceName || this.eventMeta.service_name;
        const span = new Span({ name, service_name }, this.config);
        this.childSpans.push(span);
        return span;
    }
}
export class RequestTracer extends Span {
    constructor(request, config) {
        super({
            name: 'request',
            service_name: config.serviceName,
        }, config);
        this.request = request;
        this.addRequest(request);
        this.addData(config.data);
    }

    async sendEvents(excludeSpans) {
        const sampleRate = this.getSampleRate(this.data);
        if (sampleRate >= 1 && Math.random() < 1 / sampleRate) {
            const events = this.parseToEvents().filter(event => (excludeSpans ? !excludeSpans.includes(event.name) : true));

            await this.sendBatch(events, sampleRate);
        }
    }

    finishResponse(response, error, body) {
        if (response) {
            this.addResponse(response, body);
        } else if (error) {
            this.addData({
                exception: true, error_name: error.name, stack: error.stack, message: error.message, responseException: error.toString(),
            });
        }
        this.finish();
    }

    setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
    }

    async sendBatch(events, sampleRate) {
        try {
            const url = 'https://us-east-1.tc.epsagon.com/';

            const traces = {
                app_name: this.config.app_name,
                token: this.config.token,
                version: '1.0.0',
                platform: 'Javascript',
                exceptions: [],
            };

            const trigger_trace = {
                origin: 'trigger',
                id: uuid.v4(),
                start_time: (events[0].timestamp * 0.001),
                duration: (events[0].duration_ms * 0.001),
                resource: {
                    name: events[0].request.headers.host,
                    type: 'http',
                    operation: events[0].request.method,
                    metadata: {
                        headers: events[0].request.headers,
                        pathname: new URL(events[0].request.url).pathname,
                        requestContext: events[0].request,
                    },
                },
                error_code: 0,
                exception: {},
            };

            const runner_trace = {
                origin: 'runner',
                id: uuid.v4(),
                start_time: (events[0].timestamp * 0.001),
                duration: (events[0].duration_ms * 0.001),
                resource: {
                    name: (`${events[0].request.headers.host.replace('https://', '').split('.')[0]}-worker`),
                    type: 'cloudflare_worker',
                    operation: 'execute',
                    metadata: {
                      return_value: events[0].response ? events[0].response.body : null,
                      debug_events: this.config.debug ? JSON.stringify(events) : null
                    },
                },
            };

            if (events[0].exception) {
                runner_trace.exception = {
                    type: events[0].error_name,
                    tracebook: events[0].stack,
                    additional_data: {
                        warning: false,
                        handled: false,
                    },
                    message: events[0].message,
                };
                runner_trace.error_code = 2;
            } else {
                runner_trace.exception = {};
                runner_trace.error_code = 0;
            }

            traces.events = [trigger_trace, runner_trace];

            if (events.length > 1) {
                for (let i = 1; i < events.length; i++) {
                    const hexTraceId = UUIDToHex(uuid.v4());
                    const spanId = UUIDToHex(uuid.v4()).slice(16);
                    const parentSpanId = UUIDToHex(uuid.v4()).slice(16);
                    const http_trace = {
                        origin: 'http',
                        start_time: (events[i].timestamp * 0.001),
                        duration: (events[i].duration_ms * 0.001),
                        resource: {
                            name: events[i].name,
                            type: 'http',
                            operation: events[i].request.method,
                            metadata: {
                                http_trace_id: `${hexTraceId}:${spanId}:${parentSpanId}:1`,
                                path: events[i].name,
                                request_headers: events[i].request.headers,
                                response_body: events[i].response.body,
                                status: events[i].response.status,
                                url: events[i].response.url,
                            },
                        },
                        error_code: 0,
                        exception: {},
                    };

                    traces.events.push(http_trace);
                }
            }
            const params = {
                method: 'POST',
                body: JSON.stringify(traces),
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.config.token}`,
                },
            };
            const request = new Request(url, params);
            const response = await fetch(request);
            console.log('response status: > ', response.status);
        } catch (error) {
            console.log('error in Epsagon > ', error);
        }
    }

    getSampleRate(data) {
        if (this.sampleRate !== undefined) {
            return this.sampleRate;
        }
        const sampleRates = this.config.sampleRates;
        if (typeof sampleRates === 'function') {
            return sampleRates(data);
        }
        if (!data.response && !data.response.status) {
            return sampleRates.exception;
        }

        const key = `${data.response.status.toString()[0]}xx`;
        return sampleRates[key] || 1;
    }
}
export default RequestTracer;

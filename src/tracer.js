const uuid = require('uuid');
const uuidParse = require('uuid-parse');

/**
 * Return UUID in hex string.
 * @param {string} id uuid object.
 * @returns {string} UUID in hex.
 */
function UUIDToHex(id) {
    const uuidBuffer = Buffer.alloc(16);
    uuidParse.parse(id, uuidBuffer);
    return uuidBuffer.toString('hex');
}

/**
 * Return redacted headers.
 * @param {object} from the request or response headers.
 * @param {array} redacted array of header keys to redact.
 * @returns {object} redacted request or response headers.
 */
const convertHeaders = (from, redacted) => {
    const to = {};
    for (const [key, value] of from.entries()) {
        const lowerKey = key.toLowerCase();
        to[lowerKey] = redacted.includes(lowerKey) ? 'REDACTED' : value;
    }
    return to;
};

/**
 * Represents a span.
 */
class Span {
    /**
     * @param {object} init contains name of span.
     * @param {object} config tracer configuration object.
     */
    constructor(init, config) {
        this.config = config;
        this.data = {};
        this.childSpans = [];
        this.eventMeta = {
            timestamp: Date.now(),
            name: init.name,
            trace: init.trace_context,
        };
    }

    /**
     * Parse all events captured into a single array
     * @returns {array} events array.
     */
    parseToEvents() {
        const event = Object.assign({}, this.data, this.eventMeta);
        const childEvents = this.childSpans.map(span => span.parseToEvents()).flat(1);
        return [event, ...childEvents];
    }

    /**
     * Function to add data to arbitrary data to tracer.
     * @param {object} data to add to tracer.
     */
    addData(data) {
        Object.assign(this.data, data);
    }

    /**
     * Transform request into event data, add event to tracer.
     * @param {object} request data to transform and add to tracer.
     */
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

    /**
     * Transform response into event data, add event to tracer.
     * @param {object} response data to transform and add to tracer.
     * @param {object} body optional body that can be passed for inclusion.
     */
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
        };
        const contentType = this.response.headers.get('content-type');
        if (body) {
            json.body = body;
            this.addData({ response: json });
        } else {
            if (contentType && contentType.indexOf('application/json') !== -1) {
                this.response.json().then((data) => {
                    json.body = data;
                    this.addData({ response: json });
                });
            }
            if (contentType && contentType.indexOf('text/plain;charset=UTF-8') !== -1) {
                this.response.text().then((data) => {
                    json.body = data;
                    this.addData({ response: json });
                });
            }
            if (contentType && contentType.indexOf('text/html; charset=UTF-8') !== -1) {
                this.addData({ response: json });
            }
        }
    }

    /**
     * Add log data to tracer
     * @param {string} message to be added as log.
     */
    log(message) {
        this.data.logs = this.data.logs || [];
        this.data.logs.push(`${new Date().toISOString()}: ${message}`);
    }

    /**
     * Calculate tracer start time.
     */
    start() {
        this.eventMeta.timestamp = Date.now();
    }

    /**
     * Calculate tracer end time.
     */
    finish() {
        this.eventMeta.duration_ms = Date.now() - this.eventMeta.timestamp;
    }

    /**
     * Replacement fetch that intercepts and captures request and response data.
     * @param {string} input url to fetch.
     * @param {object} init object from fetch call.
     * @returns {Promise} the fetched promise.
     */
    fetch(input, init) {
        const request = new Request(input, init);
        const childSpan = this.startChildSpan(request.url, 'fetch');
        childSpan.addRequest(request);
        const promise = fetch(request);
        promise
            .then((response) => {
                childSpan.addResponse(response);
                childSpan.finish();
            })
            .catch((reason) => {
                childSpan.addData({ exception: reason });
                childSpan.finish();
            });
        return promise;
    }

    /**
     * Create child span.
     * @param {string} name of child span.
     * @returns {object} the child span..
     */
    startChildSpan(name) {
        const span = new Span({ name }, this.config);
        this.childSpans.push(span);
        return span;
    }
}

/**
 * Represents a span.
 */
export class Tracer extends Span {
    /**
     * @param {object} request contains the incoming request data.
     * @param {object} config tracer configuration object.
     */
    constructor(request, config) {
        super({
            name: 'request',
        }, config);
        this.request = request;
        this.addRequest(request);
        this.addData(config.data);
    }

    /**
     *Parses out any spans/events that are not yet completed.
     * @param {array} excludeSpans list of spans with uncompleted transactions.
     */
    async sendEvents(excludeSpans) {
        const events = this.parseToEvents().filter(event => (excludeSpans ?
            !excludeSpans.includes(event.name) : true));
        await this.sendBatch(events);
    }

    /**
     *Takes in response data, formats according to if an error occurs, adds to tracer.
     * @param {object} response list of spans with uncompleted transactions.
     * @param {object} error object.
     * @param {object} body option body that can be passed for inclusion.
     */
    finishResponse(response, error, body) {
        if (response) {
            this.addResponse(response, body);
        } else if (error) {
            this.addData({
                exception: true,
                error_name: error.name,
                stack: error.stack,
                message: error.message,
                responseException: error.toString(),
            });
        }
        this.finish();
    }

    /**
     *Take all event data and convert into Epsagon tracer format
     * @param {array} events data for all spans.
     */
    async sendBatch(events) {
        try {
            const url = 'https://us-east-1.tc.epsagon.com/';

            const traces = {
                app_name: this.config.app_name,
                token: this.config.token,
                version: '1.0.0',
                platform: 'Javascript',
                exceptions: [],
            };

            const triggerTrace = {
                origin: 'trigger',
                id: uuid.v4(),
                start_time: (events[0].timestamp * 0.001),
                duration: (events[0].duration_ms * 0.001),
                resource: {
                    name: events[0].request.headers.host,
                    type: 'http',
                    operation: events[0].request.method,
                    metadata: {
                        'http.request.headers': events[0].request.headers,
                        'http.request.path': new URL(events[0].request.url).pathname,
                    },
                },
                error_code: 0,
                exception: {},
            };

            const runnerTrace = {
                origin: 'runner',
                id: uuid.v4(),
                start_time: (events[0].timestamp * 0.001),
                duration: (events[0].duration_ms * 0.001),
                resource: {
                    name: (`${events[0].request.headers.host.replace('https://', '').split('.')[0]}-worker`),
                    type: 'cloudflare_worker',
                    operation: 'execute',
                    metadata: {
                        'cloudflare.return_value': events[0].response ? events[0].response.body : null,
                        'cloudflare.requestContext': events[0].request,
                        'cloudflare.debug_events': this.config.debug ? JSON.stringify(events) : null,
                        'cloudflare.logs': events[0].logs || [],
                    },
                },
            };

            if (events[0].exception) {
                runnerTrace.exception = {
                    type: events[0].error_name,
                    tracebook: events[0].stack,
                    additional_data: {
                        warning: false,
                        handled: false,
                    },
                    message: events[0].message,
                };
                runnerTrace.error_code = 2;
            } else {
                runnerTrace.exception = {};
                runnerTrace.error_code = 0;
            }

            traces.events = [triggerTrace, runnerTrace];

            if (events.length > 1) {
                events.forEach((value, index) => {
                    if (index !== 0) {
                        const hexTraceId = UUIDToHex(uuid.v4());
                        const spanId = UUIDToHex(uuid.v4()).slice(16);
                        const parentSpanId = UUIDToHex(uuid.v4()).slice(16);
                        const httpTrace = {
                            origin: 'http',
                            start_time: (value.timestamp * 0.001),
                            duration: (value.duration_ms * 0.001),
                            resource: {
                                name: value.name,
                                type: 'http',
                                operation: value.request.method,
                                metadata: {
                                    http_trace_id: `${hexTraceId}:${spanId}:${parentSpanId}:1`,
                                    'http.request.path': value.name,
                                    'http.request.headers': value.request.headers,
                                    'http.response.body': value.response.body,
                                    'http.response.status_code': value.response.status,
                                    'http.url': value.response.url,
                                },
                            },
                            error_code: 0,
                            exception: {},
                        };
                        traces.events.push(httpTrace);
                    }
                });
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
            await fetch(request);
        } catch (error) {
            console.log('error in Epsagon > ', error);
        }
    }
}
export default Tracer;

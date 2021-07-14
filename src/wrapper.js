import Tracer from './tracer';

/**
 * Represents promise coordinator, ensures all promises are settled before
 * sending events to be formatted and sent to tracer.
 */
export class PromiseSettledCoordinator {
    /**
     * @param {function} finished function that runs after all promises are settled.
     */
    constructor(finished) {
        this.finished = finished;
        this.promises = [];
        this.allSettled = false;
    }

    /**
     * Adds a promise to be settled
     * @param {Promise} promise that needs to be settled.
     */
    addPromise(promise) {
        if (this.allSettled) {
            throw Error('All promises have already been settled!');
        }
        this.promises.push(promise);
        const currentLength = this.promises.length;
        const settled = Promise.allSettled(this.promises);
        settled.then((results) => {
            if (currentLength === this.promises.length) {
                this.allSettled = true;
                this.finished(results);
            }
        });
    }
}

/**
 * Represents wrapper used for instrumentation
 */
class TraceWrapper {
    /**
     * @param {object} event the cloudflare event data.
     * @param {function} listener that wraps instrumented function.
     * @param {object} config tracer configuration
     */
    constructor(event, listener, config) {
        this.event = event;
        this.listener = listener;
        this.waitUntilUsed = false;
        this.config = config;
        this.tracer = new Tracer(event.request, this.config);
        this.waitUntilSpan = this.tracer.startChildSpan('waitUntil', 'worker');
        this.settler = new PromiseSettledCoordinator(() => {
            this.waitUntilSpan.finish();
            this.sendEvents();
        });
        this.setupWaitUntil();
        this.setUpRespondWith();
    }

    /**
     * Sends events to tracer, filtering out those being waited on
     */
    async sendEvents() {
        const excludes = this.waitUntilUsed ? [] : ['waitUntil'];
        await this.tracer.sendEvents(excludes);
        this.waitUntilResolve();
    }

    /**
     * Starts wait until process
     */
    startWaitUntil() {
        this.waitUntilUsed = true;
        this.waitUntilSpan.start();
    }

    /**
     * Finishes wait until process, adds exception data as necessary
     * @param {object} error captured during request, sent to tracer
     */
    finishWaitUntil(error) {
        if (error) {
            this.tracer.addData({ exception: true, waitUtilException: error.toString() });
            this.waitUntilSpan.addData({ exception: error });
            if (error.stack) this.waitUntilSpan.addData({ stacktrace: error.stack });
        }
    }

    /**
     * Sets up wait until process
     */
    setupWaitUntil() {
        const waitUntilPromise = new Promise((resolver) => {
            this.waitUntilResolve = resolver;
        });
        this.event.waitUntil(waitUntilPromise);
        this.proxyWaitUntil();
    }

    /**
     * Adds proxy to wait until process
     */
    proxyWaitUntil() {
        const logger = this;
        this.event.waitUntil = new Proxy(this.event.waitUntil, {
            /**
             * Trap and modify incoming request
             * @param {function} _target function.
             * @param {object} _thisArg the this argument for the call.
             * @param {object} argArray list of arguments for the call.
             */
            apply(_target, _thisArg, argArray) {
                logger.startWaitUntil();
                const promise = Promise.resolve(argArray[0]);
                promise.then(() => {
                });
                logger.settler.addPromise(promise);
                promise
                    .then(() => {
                        logger.finishWaitUntil();
                    })
                    .catch((reason) => {
                        logger.finishWaitUntil(reason);
                    });
            },
        });
    }

    /**
     * Set up respond with process
     */
    setUpRespondWith() {
        this.proxyRespondWith();
        try {
            this.event.request.tracer = this.tracer;
            this.event.waitUntilTracer = this.waitUntilSpan;
            this.listener(this.event);
        } catch (err) {
            this.tracer.finishResponse(undefined, err);
        }
    }

    /**
     * Adds proxy to respond with process
     */
    proxyRespondWith() {
        const logger = this;
        this.event.respondWith = new Proxy(this.event.respondWith, {
            /**
             * Trap and modify incoming request
             * @param {function} target function.
             * @param {object} thisArg the this argument for the call.
             * @param {object} argArray list of arguments for the call.
             */
            apply(target, thisArg, argArray) {
                const responsePromise = Promise.resolve(argArray[0]);
                Reflect.apply(target, thisArg, argArray);
                const promise = new Promise((resolver, reject) => {
                    responsePromise
                        .then((response) => {
                            const clonedResponse = response.clone();
                            let responseBody;
                            const contentType = clonedResponse.headers.get('content-type');
                            if (contentType && contentType.indexOf('application/json') !== -1) {
                                clonedResponse.json().then((data) => {
                                    responseBody = data;
                                });
                            }
                            if (contentType && contentType.indexOf('text/plain;charset=UTF-8') !== -1) {
                                clonedResponse.text().then((data) => {
                                    responseBody = data;
                                });
                            }
                            setTimeout(() => {
                                logger.tracer.finishResponse(response, null, responseBody);
                                resolver(response);
                            }, 1);
                        }).catch((reason) => {
                            setTimeout(() => {
                                logger.tracer.finishResponse(undefined, reason);
                                reject(reason);
                            }, 1);
                        });
                });
                logger.settler.addPromise(promise);
            },
        });
    }
}

/**
 * Initiates tracer configuration based on user defined config and defaults.
 * @param {object} cfg user defined configuration options.
 * @returns {object} config to be used by tracer.
 */
function resolve(cfg) {
    const configDefaults = {
        acceptTraceContext: false,
        token: '',
        app_name: 'cloudflare',
        data: {},
        redactRequestHeaders: ['authorization', 'cookie', 'referer'],
        redactResponseHeaders: ['set-cookie'],
        sampleRates: () => 1,
        sendTraceContext: false,
        serviceName: 'worker',
        debug: false,
    };

    const config = Object.assign({}, configDefaults, cfg);
    config.redactRequestHeaders = config.redactRequestHeaders.map(header => header.toLowerCase());
    config.redactResponseHeaders = config.redactResponseHeaders.map(header => header.toLowerCase());
    return config;
}

/**
 * Main function, used as wrapper for instrumentation
 * @param {object} cfg user defined configuration options.
 * @param {function} listener from cloudflare worker, to be modified for tracing support.
 * @returns {Proxy} modified listener that is used to capture trace data.
 */
export function epsagon(cfg, listener) {
    const config = resolve(cfg);
    return new Proxy(listener, {
        /**
         * Trap and modify incoming request
         * @param {function} _target function.
         * @param {object} _thisArg the this argument for the call.
         * @param {object} argArray list of arguments for the call.
         */
        apply(_target, _thisArg, argArray) {
            const event = argArray[0];
            new TraceWrapper(event, listener, config);
        },
    });
}

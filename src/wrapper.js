import RequestTracer from './tracer';

class PromiseSettledCoordinator {
    constructor(finished) {
        this.finished = finished;
        this.promises = [];
        this.allSettled = false;
    }

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
exports.PromiseSettledCoordinator = PromiseSettledCoordinator;

class TraceWrapper {
    constructor(event, listener, config) {
        this.event = event;
        this.listener = listener;
        this.waitUntilUsed = false;
        this.config = config;
        this.tracer = new RequestTracer(event.request, this.config);
        this.waitUntilSpan = this.tracer.startChildSpan('waitUntil', 'worker');
        this.settler = new PromiseSettledCoordinator(() => {
            this.waitUntilSpan.finish();
            this.sendEvents();
        });
        this.setupWaitUntil();
        this.setUpRespondWith();
    }

    async sendEvents() {
        const excludes = this.waitUntilUsed ? [] : ['waitUntil'];
        await this.tracer.sendEvents(excludes);
        this.waitUntilResolve();
    }

    startWaitUntil() {
        this.waitUntilUsed = true;
        this.waitUntilSpan.start();
    }

    finishWaitUntil(error) {
        if (error) {
            this.tracer.addData({ exception: true, waitUtilException: error.toString() });
            this.waitUntilSpan.addData({ exception: error });
            if (error.stack) this.waitUntilSpan.addData({ stacktrace: error.stack });
        }
    }

    setupWaitUntil() {
        const waitUntilPromise = new Promise((resolve) => {
            this.waitUntilResolve = resolve;
        });
        this.event.waitUntil(waitUntilPromise);
        this.proxyWaitUntil();
    }

    proxyWaitUntil() {
        const logger = this;
        this.event.waitUntil = new Proxy(this.event.waitUntil, {
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

    proxyRespondWith() {
        const logger = this;
        this.event.respondWith = new Proxy(this.event.respondWith, {
            apply(target, thisArg, argArray) {
                const responsePromise = Promise.resolve(argArray[0]);
                Reflect.apply(target, thisArg, argArray);
                const promise = new Promise((resolve, reject) => {
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
                                resolve(response);
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
    };

    const config = Object.assign({}, configDefaults, cfg);
    config.redactRequestHeaders = config.redactRequestHeaders.map(header => header.toLowerCase());
    config.redactResponseHeaders = config.redactResponseHeaders.map(header => header.toLowerCase());
    return config;
}

function epsagonWrapper(cfg, listener) {
    const config = resolve(cfg);
    return new Proxy(listener, {
        apply(_target, _thisArg, argArray) {
            const event = argArray[0];
            new TraceWrapper(event, listener, config);
        },
    });
}

exports.epsagon = epsagonWrapper;

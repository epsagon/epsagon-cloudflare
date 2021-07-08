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

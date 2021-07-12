
<p align="center">
  <a href="https://epsagon.com" target="_blank" align="center">
    <img src="https://cdn2.hubspot.net/hubfs/4636301/Positive%20RGB_Logo%20Horizontal%20-01.svg" width="300">
  </a>
  <br />
</p>

# Epsagon Tracing for Cloudflare Workers

This package provides tracing to Cloudflare Workers for the collection of distributed tracing and performance metrics in [Epsagon](https://app.epsagon.com/?utm_source=github).



## Contents

- [Installation](#installation)
- [Usage](#usage)
- [Tracing Fetch Requests](#tracing-fetch-requests)


### Installation

Installation is done via the usual `npm install @epsagon/cloudflare`.

### Usage

To configure the package, you need to wrap your listener with the epsagon agent. So if your current code looks something like this:

```javascript
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request))
})

function handleRequest(request) {
  //your worker code.
}
```

You can change that to:

```javascript
import { epsagon } from '@epsagon/cloudflare'

const epsagon_config = {
  token: 'epsagon-token',
  app_name: 'application-name',
}

const listener = epsagon(epsagon_config, (event) => {
  event.respondWith(handleRequest(event.request))
})

addEventListener('fetch', listener)

function handleRequest(request) {
  //your worker code.
}
```

### Tracing Fetch Requests

To be able to associate the a subrequest with the correct incoming request, you will have to use the fetch defined on the tracer described above. The method on the tracer delegates all arguments to the regular fetch method, so the `tracer.fetch` function is a drop-in replacement for all `fetch` function calls.

Example:

```typescript
async function handleRequest(request) {
  return request.tracer.fetch('link')
}
```

/**
 * CloudFront Function — viewer-request. Maps an incoming request to the S3
 * prefix holding that deployment's artifacts.
 *
 * Runs on every request at the edge, budgeted in microseconds. No network
 * calls are possible here; the KeyValueStore is the only lookup available.
 *
 * Two addressing modes:
 *
 *   Custom domain     dep-9c21.example.com/about/
 *                     key = the hostname
 *
 *   CloudFront domain d1234.cloudfront.net/d/dep_9c21/about/
 *                     key = the deployment id from the first path segment
 *
 * The second mode exists so deployments are reachable before a custom domain
 * and its certificate are in place.
 *
 * KVS values are JSON: {"p":"projects/x/deployments/y","spa":true}
 * A bare string is also accepted and treated as the prefix.
 *
 * `spa` matters more than it looks. A CloudFront custom error response cannot
 * do SPA fallback here: its response page path is fixed, so it cannot carry a
 * per-deployment prefix and would serve some other deployment's index.html.
 * Instead, an SPA sends every extensionless path straight to its own
 * index.html, and the client router takes it from there.
 */

import cf from 'cloudfront';

var kvs = cf.kvs();

var DEFAULT_HOST_SUFFIX = '.cloudfront.net';
var PATH_MODE_PREFIX = '/d/';
var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

async function handler(event) {
    var request = event.request;
    var headers = request.headers || {};
    var host = headers.host && headers.host.value ? headers.host.value.toLowerCase() : '';

    var lookupKey;
    var path;

    if (host.length > DEFAULT_HOST_SUFFIX.length &&
        host.slice(-DEFAULT_HOST_SUFFIX.length) === DEFAULT_HOST_SUFFIX) {
        // Path mode: /d/<deploymentId>/<rest>
        if (request.uri.slice(0, PATH_MODE_PREFIX.length) !== PATH_MODE_PREFIX) {
            return errorResponse(404, 'No deployment in path');
        }
        var rest = request.uri.slice(PATH_MODE_PREFIX.length);
        var slash = rest.indexOf('/');
        lookupKey = slash === -1 ? rest : rest.slice(0, slash);
        path = slash === -1 ? '/' : rest.slice(slash);

        if (!ID_PATTERN.test(lookupKey)) {
            return errorResponse(404, 'Invalid deployment id');
        }
    } else {
        lookupKey = host;
        path = request.uri;
    }

    // Reject traversal before it reaches the origin. CloudFront normalises the
    // URI on the way out, so a surviving `..` could climb out of the prefix and
    // into another deployment's artifacts. Encoded forms are rejected too.
    var lowered = path.toLowerCase();
    if (lowered.indexOf('..') !== -1 || lowered.indexOf('%2e') !== -1) {
        return errorResponse(400, 'Invalid path');
    }

    var raw;
    try {
        raw = await kvs.get(lookupKey);
    } catch (e) {
        // A missing key throws rather than returning null.
        return errorResponse(404, 'Unknown deployment');
    }
    if (!raw) {
        return errorResponse(404, 'Unknown deployment');
    }

    var target = parseTarget(raw);
    if (!target.prefix) {
        return errorResponse(404, 'Unknown deployment');
    }

    request.uri = join(target.prefix, resolvePath(path, target.spa));
    return request;
}

/** KVS values are JSON, but tolerate a bare prefix string. */
function parseTarget(raw) {
    if (raw.charAt(0) === '{') {
        try {
            var parsed = JSON.parse(raw);
            return { prefix: parsed.p || '', spa: parsed.spa === true };
        } catch (e) {
            return { prefix: '', spa: false };
        }
    }
    return { prefix: raw, spa: false };
}

/**
 * Turn a request path into an object key.
 *
 *   /            -> /index.html
 *   /about/      -> /about/index.html
 *   /about       -> /about/index.html   (static)  |  /index.html (spa)
 *   /app.abc.js  -> unchanged
 */
function resolvePath(path, spa) {
    if (path === '' || path === '/') {
        return '/index.html';
    }
    if (path.charAt(path.length - 1) === '/') {
        return spa ? '/index.html' : path + 'index.html';
    }

    var lastSlash = path.lastIndexOf('/');
    var lastSegment = path.slice(lastSlash + 1);
    if (lastSegment.indexOf('.') === -1) {
        return spa ? '/index.html' : path + '/index.html';
    }
    return path;
}

/** `projects/x/deployments/y` + `/index.html` -> `/projects/x/deployments/y/index.html` */
function join(prefix, path) {
    var p = prefix;
    if (p.charAt(0) === '/') {
        p = p.slice(1);
    }
    if (p.length > 0 && p.charAt(p.length - 1) === '/') {
        p = p.slice(0, p.length - 1);
    }
    return '/' + p + path;
}

function errorResponse(statusCode, message) {
    return {
        statusCode: statusCode,
        statusDescription: message,
        headers: {
            'content-type': { value: 'text/plain; charset=utf-8' },
            // Short, so a deployment that appears a moment later is reachable.
            'cache-control': { value: 'max-age=10' }
        },
        body: message + '\n'
    };
}

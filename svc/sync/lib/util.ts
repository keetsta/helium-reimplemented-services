export const respond = (
    status: number,
    response?: string | object,
    headers?: Record<string, string>,
) => {
    if (response && typeof response === 'object') {
        response = JSON.stringify(response);
        headers = { 'content-type': 'application/json', ...headers };
    }
    response ||= '';

    headers ??= {};
    headers['content-type'] ??= 'text/plain';

    return new Response(response, { status, headers });
};

export const respondWithError = (e: unknown) => {
    if (typeof e === 'string') {
        e = { status: 400, text: e };
    }

    if (e instanceof Object) {
        if ('status' in e && 'text' in e) {
            return respond(e.status as number, `error ${e.status}: ${e.text}`);
        }
    }

    return respond(500, 'server error');
};

// Hash the bearer token so the raw secret is never used as a storage key
// and never persisted. The token is the only credential; whoever holds it
// owns its namespace.
export const hashToken = async (token: string) => {
    const data = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
};

// Constant-time-ish token validation: reject anything implausible early.
// Tokens are opaque client-generated secrets; we only require sane length.
export const isValidToken = (token: string) => {
    return token.length >= 32 && token.length <= 512;
};

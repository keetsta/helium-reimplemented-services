import { hashToken, isValidToken, respond } from './util.ts';

const kv = await Deno.openKv(Deno.env.get('DENO_KV_PATH') || undefined);

// Collections a device is allowed to sync. Keep this an explicit allowlist so
// a compromised/buggy client can't spray arbitrary keys into the store.
const COLLECTIONS = new Set(['extensions', 'bookmarks']);

// Per-collection payload cap. The blob is opaque JSON produced by the client
// (extension id list / bookmark tree). Default 1 MiB, override via env.
const MAX_BYTES = Number(Deno.env.get('SYNC_MAX_BYTES') ?? 1024 * 1024);

interface StoredRecord {
    version: number;
    updatedAt: number;
    // Opaque client payload. The server never interprets it.
    data: unknown;
}

const getToken = (request: Request) => {
    const auth = request.headers.get('authorization') ?? '';
    const match = auth.match(/^Bearer (.+)$/);
    if (!match) {
        throw { status: 401, text: 'missing or malformed bearer token' };
    }

    const token = match[1].trim();
    if (!isValidToken(token)) {
        throw { status: 401, text: 'token must be 32-512 chars' };
    }

    return token;
};

const parseCollection = (pathname: string) => {
    // pathname is "/extensions" or "/bookmarks" (nginx strips the /sync prefix)
    const collection = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!COLLECTIONS.has(collection)) {
        throw { status: 404, text: 'unknown collection' };
    }
    return collection;
};

const handleGet = async (key: Deno.KvKey) => {
    const entry = await kv.get<StoredRecord>(key);
    if (!entry.value) {
        // Nothing synced yet for this device+collection.
        return respond(200, { version: 0, data: null });
    }

    return respond(200, {
        version: entry.value.version,
        updatedAt: entry.value.updatedAt,
        data: entry.value.data,
    });
};

const handlePut = async (key: Deno.KvKey, request: Request) => {
    const body = await request.text();
    if (body.length > MAX_BYTES) {
        throw { status: 413, text: `payload exceeds ${MAX_BYTES} bytes` };
    }

    let parsed: { baseVersion?: number; data?: unknown };
    try {
        parsed = JSON.parse(body || '{}');
    } catch {
        throw { status: 400, text: 'body must be valid json' };
    }

    if (!('data' in parsed)) {
        throw { status: 400, text: 'body must contain a "data" field' };
    }

    // Optimistic concurrency: the client sends the version it last saw.
    // If the stored version moved on, the client must GET and merge first.
    const baseVersion = Number(parsed.baseVersion ?? 0);
    const current = await kv.get<StoredRecord>(key);
    const currentVersion = current.value?.version ?? 0;

    if (baseVersion !== currentVersion) {
        return respond(409, {
            error: 'version conflict',
            version: currentVersion,
            data: current.value?.data ?? null,
        });
    }

    const next: StoredRecord = {
        version: currentVersion + 1,
        updatedAt: Date.now(),
        data: parsed.data,
    };

    // Atomic check-and-set guards against two devices racing on the same key.
    const result = await kv.atomic()
        .check(current)
        .set(key, next)
        .commit();

    if (!result.ok) {
        return respond(409, {
            error: 'concurrent write, retry',
            version: currentVersion,
        });
    }

    return respond(200, { version: next.version, updatedAt: next.updatedAt });
};

export const handle = async (request: Request) => {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
        return respond(200, 'ok');
    }

    const token = getToken(request);
    const collection = parseCollection(url.pathname);
    const key: Deno.KvKey = ['sync', await hashToken(token), collection];

    switch (request.method) {
        case 'GET':
            return await handleGet(key);
        case 'PUT':
            return await handlePut(key, request);
        default:
            throw { status: 405, text: 'method not allowed' };
    }
};

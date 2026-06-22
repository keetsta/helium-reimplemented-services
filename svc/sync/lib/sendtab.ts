import { hashToken, isValidToken, respond } from './util.ts';
import { kv } from './db.ts';

// Send-tab-to-device delivery on top of the same dumb KV store, but with a
// per-device inbox and long-poll so a sent tab arrives within milliseconds
// instead of on the next poll tick.
//
// Routing (nginx strips the "/sync" prefix, so the service sees "/sendtab/..."):
//   POST /sendtab/<deviceId>   enqueue a tab for <deviceId>
//   GET  /sendtab/<deviceId>   long-poll the inbox of <deviceId>
//
// Storage:  ['sendtab', hashedToken, deviceId] -> { seq, items: Message[] }
// POST appends to `items` and bumps `seq`. GET drains `items` (atomic take +
// clear) and returns them, so each tab is delivered exactly once: there is no
// growing backlog and no redelivery loop. `seq` stays monotonic only so a
// parked kv.watch on the GET side reliably wakes on every write.

const MAX_BYTES = Number(Deno.env.get('SENDTAB_MAX_BYTES') ?? 64 * 1024);
const MAX_ITEMS = Number(Deno.env.get('SENDTAB_MAX_ITEMS') ?? 50);
// Cap a single long-poll wait. Kept under typical proxy idle timeouts.
const MAX_WAIT_MS = Number(Deno.env.get('SENDTAB_MAX_WAIT_MS') ?? 25_000);

interface Inbox {
    seq: number;
    items: unknown[];
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

// pathname after the /sendtab prefix is "/<deviceId>".
const parseDeviceId = (pathname: string) => {
    const rest = pathname.replace(/^\/sendtab\/?/, '').replace(/\/+$/, '');
    const id = decodeURIComponent(rest);
    // Device ids are client-generated uuids; keep this strict so a bad client
    // can't smuggle separators into the KV key.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
        throw { status: 400, text: 'invalid device id' };
    }
    return id;
};

const handlePost = async (key: Deno.KvKey, request: Request) => {
    const body = await request.text();
    if (body.length > MAX_BYTES) {
        throw { status: 413, text: `payload exceeds ${MAX_BYTES} bytes` };
    }
    let message: unknown;
    try {
        message = JSON.parse(body || 'null');
    } catch {
        throw { status: 400, text: 'body must be valid json' };
    }
    if (message === null || typeof message !== 'object') {
        throw { status: 400, text: 'body must be a json object' };
    }

    // Append to the inbox under optimistic retry. Bounded item count keeps a
    // spamming sender from growing the inbox without limit.
    for (let attempt = 0; attempt < 8; attempt++) {
        const entry = await kv.get<Inbox>(key);
        const inbox: Inbox = entry.value ?? { seq: 0, items: [] };
        const next: Inbox = {
            seq: inbox.seq + 1,
            items: [...inbox.items, message].slice(-MAX_ITEMS),
        };
        const result = await kv.atomic()
            .check(entry)
            .set(key, next)
            .commit();
        if (result.ok) {
            return respond(200, { seq: next.seq });
        }
    }
    throw { status: 409, text: 'too much contention, retry' };
};

// Atomically take everything in the inbox and leave it empty. Returns the
// drained items (possibly empty). `seq` is kept monotonic so kv.watch on the
// GET side still sees a write and parked long-polls wake. Draining on read is
// what makes each tab deliver exactly once: once handed to a client they're
// gone server-side, so a re-poll can't redeliver them (no growing backlog, no
// delivery loop).
const drainOnce = async (key: Deno.KvKey): Promise<unknown[]> => {
    for (let attempt = 0; attempt < 8; attempt++) {
        const entry = await kv.get<Inbox>(key);
        const items = entry.value?.items ?? [];
        if (items.length === 0) {
            return [];
        }
        const next: Inbox = { seq: entry.value?.seq ?? 0, items: [] };
        const result = await kv.atomic()
            .check(entry)
            .set(key, next)
            .commit();
        if (result.ok) {
            return items;
        }
    }
    // Lost the race repeatedly; report empty and let the client re-poll.
    return [];
};

const handleGet = async (key: Deno.KvKey, _url: URL) => {
    // Deliver anything already waiting, draining it so it's never sent twice.
    const ready = await drainOnce(key);
    if (ready.length > 0) {
        return respond(200, { items: ready });
    }

    // Nothing waiting: hold the request open until the key changes or we hit
    // the wait cap. kv.watch wakes us only when THIS device's inbox is written,
    // so an idle device costs one parked request.
    const watcher = kv.watch<[Inbox]>([key]);
    const reader = watcher.getReader();
    const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), MAX_WAIT_MS)
    );

    try {
        while (true) {
            const race = await Promise.race([reader.read(), timeout]);
            if (race === 'timeout') {
                // 204: no new tabs; client immediately re-polls.
                return respond(204);
            }
            const { done } = race as ReadableStreamReadResult<unknown>;
            if (done) {
                return respond(204);
            }
            // The key changed; drain whatever landed. A spurious wake (e.g. the
            // initial emission echoing current empty state) drains to nothing
            // and we keep waiting until the timeout promise wins.
            const drained = await drainOnce(key);
            if (drained.length > 0) {
                return respond(200, { items: drained });
            }
        }
    } finally {
        reader.cancel();
    }
};

export const handleSendTab = async (request: Request, url: URL) => {
    const token = getToken(request);
    const deviceId = parseDeviceId(url.pathname);
    const key: Deno.KvKey = ['sendtab', await hashToken(token), deviceId];

    switch (request.method) {
        case 'POST':
            return await handlePost(key, request);
        case 'GET':
            return await handleGet(key, url);
        default:
            throw { status: 405, text: 'method not allowed' };
    }
};

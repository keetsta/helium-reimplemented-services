// Single shared Deno KV handle. Opening the same database path more than once
// in a process is wasteful and can race, so every service module imports the
// handle from here.
export const kv = await Deno.openKv(Deno.env.get('DENO_KV_PATH') || undefined);

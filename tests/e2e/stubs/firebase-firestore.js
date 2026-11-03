// Minimal in-memory Firestore stand-in (paths, where/orderBy/limit, batches, snapshots).
const F = (window.__FAKE ||= { user: null, docs: {} });
F.writes ||= [];
class Ts { constructor(d = new Date()) { this._d = d; } toDate() { return this._d; } toMillis() { return +this._d; } }
const SERVER_TS = { __serverTs: true };
const listeners = [];
const join = (parts) => parts.join('/');
export function getFirestore() { return { __db: true }; }
export function collection(_db, ...parts) { return { type: 'col', path: join(parts) }; }
export function doc(_db, ...parts) { return { type: 'doc', path: join(parts), id: parts[parts.length - 1] }; }
export function where(field, op, value) { return { kind: 'where', field, op, value }; }
export function orderBy(field, dir = 'asc') { return { kind: 'orderBy', field, dir }; }
export function limit(n) { return { kind: 'limit', n }; }
export function query(col, ...cons) { return { type: 'query', path: col.path, cons }; }
export function serverTimestamp() { return SERVER_TS; }
const resolve = (v) => v === SERVER_TS ? new Ts() : (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Ts) && !Array.isArray(v)) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : Array.isArray(v) ? v.map(resolve) : v;
const val = (x) => x instanceof Ts ? x.toMillis() : x instanceof Date ? +x : x;
function snapDoc(path) { const d = F.docs[path]; return { id: path.split('/').pop(), exists: () => !!d, data: () => d && structuredCloneSafe(d), ref: { path } }; }
function structuredCloneSafe(d) { return { ...d }; }
function run(q) {
    const depth = q.path.split('/').length + 1;
    let rows = Object.keys(F.docs).filter(p => p.startsWith(q.path + '/') && p.split('/').length === depth).map(snapDoc);
    for (const c of q.cons || []) {
        if (c.kind === 'where') rows = rows.filter(r => { const v = r.data()[c.field]; return c.op === '==' ? v === c.value : true; });
        if (c.kind === 'orderBy') rows.sort((a, b) => (val(a.data()[c.field]) > val(b.data()[c.field]) ? 1 : -1) * (c.dir === 'desc' ? -1 : 1));
        if (c.kind === 'limit') rows = rows.slice(0, c.n);
    }
    return { docs: rows, empty: rows.length === 0, size: rows.length };
}
function notify() { for (const l of listeners) l.cb(run(l.q)); }
function put(path, data, merge) { F.docs[path] = merge ? { ...(F.docs[path] || {}), ...resolve(data) } : resolve(data); F.writes.push({ path, data: F.docs[path] }); }
export async function getDoc(ref) { return snapDoc(ref.path); }
export async function getDocs(q) { return run(q.type === 'col' ? { path: q.path, cons: [] } : q); }
export async function setDoc(ref, data) { put(ref.path, data); notify(); }
export async function updateDoc(ref, data) { if (!F.docs[ref.path]) throw Object.assign(new Error('not-found'), { code: 'not-found' }); put(ref.path, data, true); notify(); }
export async function addDoc(col, data) { const id = 'id' + Math.random().toString(36).slice(2, 10); put(`${col.path}/${id}`, data); notify(); return { id, path: `${col.path}/${id}` }; }
export function onSnapshot(q, cb) { const l = { q: q.type === 'col' ? { path: q.path, cons: [] } : q, cb }; listeners.push(l); setTimeout(() => cb(run(l.q)), 0); return () => listeners.splice(listeners.indexOf(l), 1); }
export function writeBatch() {
    const ops = [];
    return {
        set: (ref, d) => ops.push(() => put(ref.path, d)),
        update: (ref, d) => ops.push(() => { if (!F.docs[ref.path]) throw new Error('not-found ' + ref.path); put(ref.path, d, true); }),
        commit: async () => { ops.forEach(o => o()); notify(); },
    };
}

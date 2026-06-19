// Простое хранилище в IndexedDB для докачки: уже скачанные главы сохраняются,
// чтобы после блокировки антиботом (перезагрузка + проверка) повторный запуск
// продолжал с места, а не начинал книгу заново.

const DB_NAME = 'ranobe-ebook-loader';
const STORE = 'chapters';

let dbp: Promise<IDBDatabase>;

function db(): Promise<IDBDatabase> {
    return dbp ||= new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

async function store(mode: IDBTransactionMode) {
    return (await db()).transaction(STORE, mode).objectStore(STORE);
}

export async function cacheGet<T = any>(key: string): Promise<T | undefined> {
    try {
        const s = await store('readonly');
        return await new Promise(resolve => {
            const r = s.get(key);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => resolve(undefined);
        });
    } catch {
        return undefined;
    }
}

export async function cacheSet(key: string, value: any): Promise<void> {
    try {
        const s = await store('readwrite');
        await new Promise<void>(resolve => {
            const r = s.put(value, key);
            r.onsuccess = () => resolve();
            r.onerror = () => resolve();
        });
    } catch {
        /* кэш необязателен — игнорируем сбои хранилища */
    }
}

// Сколько ключей с заданным префиксом в кэше (для оценки прогресса докачки).
export async function cacheCount(prefix: string): Promise<number> {
    try {
        const s = await store('readonly');
        return await new Promise(resolve => {
            let n = 0;
            const r = s.openCursor();
            r.onsuccess = () => {
                const c = r.result;
                if (c) {
                    if (String(c.key).startsWith(prefix)) n++;
                    c.continue();
                } else {
                    resolve(n);
                }
            };
            r.onerror = () => resolve(n);
        });
    } catch {
        return 0;
    }
}

// Удалить все ключи с заданным префиксом (например, всё по одной книге).
export async function cacheClearPrefix(prefix: string): Promise<void> {
    try {
        const s = await store('readwrite');
        await new Promise<void>(resolve => {
            const r = s.openCursor();
            r.onsuccess = () => {
                const c = r.result;
                if (c) {
                    if (String(c.key).startsWith(prefix)) c.delete();
                    c.continue();
                } else {
                    resolve();
                }
            };
            r.onerror = () => resolve();
        });
    } catch {
        /* игнорируем */
    }
}

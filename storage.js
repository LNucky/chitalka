const db = new Promise((resolve, reject) => {
  const request = indexedDB.open('personal-chitalka', 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore('books', { keyPath: 'id' })
    request.result.createObjectStore('progress', { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

export async function run(stores, mode, operation) {
  const connection = await db
  return new Promise((resolve, reject) => {
    const tx = connection.transaction(stores, mode)
    tx.onabort = () => reject(tx.error)
    const request = operation(tx)
    tx.oncomplete = () => resolve(request?.result)
  })
}

export const all = name => run(name, 'readonly', tx => tx.objectStore(name).getAll())
export const get = (name, id) => run(name, 'readonly', tx => tx.objectStore(name).get(id))
export const put = (name, value) => run(name, 'readwrite', tx => tx.objectStore(name).put(value))
export const removeBook = id => run(['books', 'progress'], 'readwrite', tx => {
  tx.objectStore('books').delete(id)
  tx.objectStore('progress').delete(id)
})

export function saveProgress(entries) {
  return run('progress', 'readwrite', tx => {
    const store = tx.objectStore('progress')
    for (const entry of entries) {
      const existing = store.get(entry.id)
      existing.onsuccess = () => {
        if (!existing.result || existing.result.updatedAt <= entry.updatedAt) store.put(entry)
      }
    }
  })
}

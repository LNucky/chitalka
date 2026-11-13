import { SentenceReader } from './sentences.js'
import { makeBook } from './vendor/foliate/view.js'
import { all, get, put, removeBook, saveProgress } from './storage.js'

const $ = id => document.getElementById(id)
const themes = { paper: ['#f7f4eb', '#242a25'], light: ['#ffffff', '#242a25'], dark: ['#191d1a', '#ecefe9'] }
let prefs = { size: 21, theme: 'paper', mode: 'sentence' }
try {
  const stored = JSON.parse(localStorage.getItem('chitalka-prefs') ?? '{}')
  if (stored && Number.isInteger(stored.size) && stored.size >= 16 && stored.size <= 34) prefs.size = stored.size
  if (stored && Object.hasOwn(themes, stored.theme)) prefs.theme = stored.theme
  if (stored?.mode === 'page') prefs.mode = 'page'
} catch { /* Use defaults if preferences are unavailable. */ }

let active
let sentenceHintTimer
const status = message => { $('status').textContent = message }
const percent = fraction => Math.floor(100 * Math.min(1, Math.max(0, fraction)))
const text = value => typeof value === 'string' ? value : Object.values(value ?? {}).find(v => typeof v === 'string')
const authors = value => [value].flat().map(v => text(v?.name ?? v)).filter(Boolean).join(', ')

function resetSentenceHint() {
  clearTimeout(sentenceHintTimer)
  const hint = $('sentence-hint')
  hint.classList.remove('is-visible')
  if (!active?.sentenceMode || active.navigating || document.hidden || $('toc').open || $('prefs').open) return
  sentenceHintTimer = setTimeout(() => hint.classList.add('is-visible'), 7000)
}

function applyPrefs() {
  const [background, color] = themes[prefs.theme]
  document.documentElement.dataset.theme = prefs.theme
  document.querySelector('meta[name=theme-color]').content = background
  $('size').value = prefs.size
  $('size-value').value = prefs.size + ' px'
  $('theme').value = prefs.theme
  $('reading-mode').value = active && !active.sentenceMode ? 'page' : prefs.mode
  $('sentence-text').style.fontSize = prefs.size + 'px'
  active?.view.renderer?.setStyles?.(`
    :root { color-scheme: ${prefs.theme === 'dark' ? 'dark' : 'light'}; }
    html, body { background: ${background} !important; color: ${color} !important; }
    body { font-family: Georgia, serif !important; font-size: ${prefs.size}px !important; line-height: 1.55 !important; }
    p, li, blockquote { color: inherit !important; font-size: inherit !important; line-height: inherit !important; }
    a { color: inherit !important; }
  `)
}

function savePrefs() {
  try { localStorage.setItem('chitalka-prefs', JSON.stringify(prefs)) } catch { /* Reading still works. */ }
  applyPrefs()
}

function updatePrefs() {
  prefs.size = Number($('size').value)
  prefs.theme = $('theme').value
  savePrefs()
}

async function renderShelf() {
  const [books, progress] = await Promise.all([all('books'), all('progress')])
  const positions = new Map(progress.map(item => [item.id, item]))
  books.sort((a, b) => (positions.get(b.id)?.updatedAt ?? b.addedAt) - (positions.get(a.id)?.updatedAt ?? a.addedAt))
  $('empty').hidden = books.length > 0
  $('books').replaceChildren(...books.map(book => {
    const li = document.createElement('li')
    const open = document.createElement('button')
    const title = document.createElement('strong')
    const meta = document.createElement('small')
    const position = positions.get(book.id)
    open.className = 'book'
    title.textContent = book.title
    meta.textContent = [book.author, position ? 'Прочитано ' + percent(position.fraction) + '%' : 'Начать чтение'].filter(Boolean).join(' · ')
    open.append(title, meta)
    open.onclick = () => task(() => openBook(book))
    const remove = document.createElement('button')
    remove.className = 'delete'
    remove.textContent = '×'
    remove.setAttribute('aria-label', 'Удалить «' + book.title + '»')
    remove.onclick = () => task(async () => {
      if (!confirm('Удалить «' + book.title + '» и её прогресс с этого устройства?')) return
      await removeBook(book.id)
      await renderShelf()
    })
    li.append(open, remove)
    return li
  }))
}

async function parseBook(file) {
  const book = await makeBook(file)
  if (!book.sections?.length || !book.sections.some(section => section.linear !== 'no')) {
    book.destroy?.()
    throw new Error('В книге нет доступного текста.')
  }
  return book
}

async function normalizeFile(file) {
  const name = file.name.toLowerCase()
  if (!/\.(epub|fb2|zip)$/.test(name)) throw new Error('Выбери EPUB, FB2 или FB2.ZIP.')
  if (file.size > 64 * 1024 * 1024) throw new Error('Размер файла превышает 64 МБ.')
  if (!name.endsWith('.zip') && !name.endsWith('.epub')) return new File([file], name)
  const { configure, ZipReader, BlobReader } = await import('./vendor/foliate/vendor/zip.js')
  configure({ useWebWorkers: false })
  const zip = new ZipReader(new BlobReader(file))
  try {
    const entries = await zip.getEntries()
    const files = entries.filter(entry => !entry.directory)
    if (files.some(entry => entry.encrypted) || files.reduce((size, entry) => size + entry.uncompressedSize, 0) > 128 * 1024 * 1024) {
      throw new Error('Архив защищён паролем или слишком большой после распаковки.')
    }
    if (name.endsWith('.epub')) {
      if (!files.some(entry => entry.filename === 'META-INF/container.xml')) throw new Error('Файл не похож на EPUB.')
      return new File([file], name)
    }
    const fb2 = files.filter(entry => /\.fb2$/i.test(entry.filename) && !entry.filename.startsWith('__MACOSX/'))
    if (fb2.length !== 1) throw new Error('В ZIP-архиве должен быть ровно один файл FB2.')
    const { BlobWriter } = await import('./vendor/foliate/vendor/zip.js')
    return new File([await fb2[0].getData(new BlobWriter())], name.replace(/(?:\.fb2)?\.zip$/, '.fb2'))
  } finally {
    await zip.close()
  }
}

async function importBook(file) {
  status('Открываю книгу…')
  const normalized = await normalizeFile(file)
  const digest = await crypto.subtle.digest('SHA-256', await normalized.arrayBuffer())
  const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const existing = await get('books', id)
  if (existing) return openBook(existing)
  const book = await parseBook(normalized)
  const record = {
    id, blob: normalized, name: normalized.name, addedAt: Date.now(),
    title: text(book.metadata?.title) || file.name, author: authors(book.metadata?.author),
  }
  try {
    await openBook(record, book)
    await put('books', record)
  } catch (error) {
    if (active?.id === id) closeBook()
    else book.destroy?.()
    throw error
  }
}

function showChapters(items, depth = 0) {
  for (const item of items ?? []) {
    if (item.href) {
      const button = document.createElement('button')
      button.textContent = item.label || 'Раздел'
      button.style.paddingInlineStart = Math.min(depth, 5) * .7 + .75 + 'rem'
      button.onclick = () => {
        $('toc').close()
        void navigate(() => {
          setLinkReturn(active, null)
          return goToReadingPosition(active, item.href)
        })
      }
      $('chapters').append(button)
    }
    showChapters(item.subitems, depth + 1)
  }
}

function setLinkReturn(reader, linkReturn) {
  reader.linkReturn = linkReturn
  $('return-link').hidden = !linkReturn
  $('reading-progress').hidden = Boolean(linkReturn)
}

async function returnToText(reader) {
  const origin = reader.linkReturn
  if (!origin) return
  setLinkReturn(reader, null)
  if (!await goToReadingPosition(reader, origin.cfi)) setLinkReturn(reader, origin)
}

function followBookLink(reader, event) {
  const { a, href } = event.detail
  const { view, linkReturn } = reader
  const type = a.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? ''
  const role = a.getAttribute('role')
  const target = view.resolveNavigation(href)
  if (linkReturn && (role === 'doc-backlink' || /\b(backlink|backref)\b/.test(type)
    || (linkReturn.anchorId && target?.index === linkReturn.section && href.split('#').at(-1) === linkReturn.anchorId))) {
    event.preventDefault()
    void navigate(() => returnToText(reader))
    return
  }
  const location = reader.sentenceMode ? reader.sentences.location : view.lastLocation
  if (!Number.isInteger(target?.index) || !reader.book.sections[target.index] || !location?.cfi) return
  event.preventDefault()
  void navigate(async () => {
    const isNote = role === 'doc-noteref' || /\bnoteref\b/.test(type)
      || reader.book.sections[target.index].linear === 'no'
    setLinkReturn(reader, linkReturn ?? {
      cfi: location.cfi, section: location.section?.current, anchorId: a.id, isNote,
    })
    $('milestone').textContent = ''
    if (!await goToReadingPosition(reader, href)) setLinkReturn(reader, linkReturn)
  })
}

function updateReadingProgress(reader, detail) {
  if (reader.linkReturn?.isNote) return
  const fraction = Number.isFinite(detail.fraction) ? detail.fraction : 0
  const value = percent(fraction >= 1 - 1e-9 ? 1 : fraction)
  $('position').value = value + '%'
  $('progress-bar').value = value

  const highest = Math.max(reader.highest, value)
  const milestone = Math.floor(highest / 25) * 25
  const paged = reader.turning || detail.reason === 'page' || detail.reason === 'snap'
  $('milestone').textContent = paged && !reader.linkReturn && milestone > reader.highest
    ? (milestone === 100 ? '✦ Ты дошёл до конца книги' : '✦ Уже ' + milestone + '% книги')
    : ''
  reader.highest = highest

  if (!detail.cfi) return
  void saveProgress([{ id: reader.id, cfi: detail.cfi, fraction, highest, updatedAt: Date.now() }]).catch(() => {
    if (active === reader) $('position').value = 'Прогресс не сохранён'
  })
}

async function goToReadingPosition(reader, target) {
  if (!reader.sentenceMode) return reader.view.goTo(target)
  const location = await reader.sentences.goTo(target)
  if (location) updateReadingProgress(reader, location)
  return location
}

async function showReadingMode(reader, mode, target) {
  reader.sentenceMode = mode === 'sentence' && Boolean(reader.sentences)
  $('sentence').hidden = !reader.sentenceMode
  $('pages').hidden = reader.sentenceMode
  $('prev').setAttribute('aria-label', reader.sentenceMode ? 'Предыдущее предложение' : 'Предыдущая страница')
  $('next').setAttribute('aria-label', reader.sentenceMode ? 'Следующее предложение' : 'Следующая страница')
  if (reader.sentenceMode) {
    const first = reader.book.sections.findIndex(section => section.linear !== 'no')
    if (await goToReadingPosition(reader, target ?? first)) return true
    return showReadingMode(reader, 'page', target)
  }
  await reader.view.init({ lastLocation: target })
  return mode === 'page'
}

async function openBook(record, parsed) {
  const previous = await get('progress', record.id)
  const book = parsed ?? await parseBook(new File([record.blob], record.name))
  const view = document.createElement('foliate-view')
  const reader = { id: record.id, view, book, navigating: true, highest: previous?.highest ?? percent(previous?.fraction ?? 0) }
  active = reader
  setLinkReturn(reader, null)
  $('milestone').textContent = ''
  $('progress-bar').value = 0
  $('title').textContent = record.title
  $('position').value = 'Открываю…'
  $('shelf').hidden = true
  $('reader').hidden = false
  $('sentence').hidden = true
  $('pages').hidden = false
  $('pages').replaceChildren(view)
  try {
    book.transformTarget?.addEventListener('load', event => {
      if (event.detail.isScript) event.detail.allow = false
    })
    await view.open(book)
    view.renderer.setAttribute('max-column-count', '1')
    if (typeof Intl.Segmenter === 'function' && !view.isFixedLayout && book.sections.some(section => section.createDocument)) {
      reader.sentences = new SentenceReader(view, $('sentence-text'))
    }
    $('reading-mode').disabled = !reader.sentences
    applyPrefs()
    view.addEventListener('external-link', event => event.preventDefault())
    view.addEventListener('load', ({ detail: { doc } }) => {
      doc.documentElement.style.setProperty('overscroll-behavior-y', 'none', 'important')
      doc.body?.style.setProperty('overscroll-behavior-y', 'none', 'important')
      doc.addEventListener('keydown', keys)
    })
    view.addEventListener('link', event => followBookLink(reader, event))
    view.addEventListener('relocate', ({ detail }) => {
      if (!reader.sentenceMode) updateReadingProgress(reader, detail)
    })
    $('chapters').replaceChildren()
    showChapters(book.toc)
    $('contents').disabled = !$('chapters').children.length
    await showReadingMode(reader, prefs.mode, previous?.cfi)
    applyPrefs()
    active.navigating = false
    resetSentenceHint()
    status('')
    $('reader').focus({ preventScroll: true })
  } catch (error) {
    closeBook()
    throw error
  }
}

function closeBook() {
  $('toc').close()
  $('prefs').close()
  active?.view.close()
  active?.book.destroy?.()
  active = null
  resetSentenceHint()
  $('pages').replaceChildren()
  $('sentence-text').replaceChildren()
  $('reader').hidden = true
  $('shelf').hidden = false
}

let busy = false
async function task(action) {
  if (busy) return
  busy = true
  try { await action() }
  catch (error) {
    console.error(error)
    status(error instanceof DOMException
      ? 'Не удалось открыть файл или сохранить данные. Проверь доступное место в Safari.'
      : 'Не удалось завершить действие. ' + (error.message || 'Проверь формат файла и отсутствие DRM.'))
  } finally { busy = false }
}

async function navigate(action) {
  const current = active
  if (!current || current.navigating || busy) return
  current.navigating = true
  resetSentenceHint()
  try { await action() }
  catch (error) {
    console.error(error)
    $('position').value = 'Не удалось перейти'
  } finally {
    current.navigating = false
    resetSentenceHint()
  }
}

function turnPage(direction) {
  const reader = active
  return navigate(async () => {
    reader.turning = true
    try {
      if (reader.sentenceMode) {
        const location = await reader.sentences.step(direction === 'left' ? -1 : 1)
        if (location) updateReadingProgress(reader, location)
      } else await (direction === 'left' ? reader.view.goLeft() : reader.view.goRight())
    } finally {
      reader.turning = false
    }
  })
}

function keys(event) {
  if (!active || $('toc').open || $('prefs').open || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    void turnPage(event.key === 'ArrowLeft' ? 'left' : 'right')
  }
}

async function exportProgress() {
  const data = { version: 1, progress: await all('progress') }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'chitalka-progress.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

async function importProgress(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error('Файл прогресса слишком большой.')
  const data = JSON.parse(await file.text())
  if (data?.version !== 1 || !Array.isArray(data.progress) || data.progress.some(item =>
    !item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) ||
    typeof item.cfi !== 'string' || !item.cfi.startsWith('epubcfi(') || !item.cfi.endsWith(')') ||
    !Number.isFinite(item.fraction) || !Number.isFinite(item.updatedAt) ||
    (item.highest !== undefined && (!Number.isInteger(item.highest) || item.highest < 0 || item.highest > 100)))) {
    throw new Error('Выбери JSON, экспортированный из Читалки.')
  }
  await saveProgress(data.progress)
  await renderShelf()
  status('Прогресс импортирован. При совпадении книги сохранена более свежая позиция.')
}

$('add').onclick = () => $('file').click()
$('file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) void task(() => importBook(file))
}
$('back').onclick = () => task(async () => {
  if (active?.navigating) return
  closeBook()
  await renderShelf()
  $('add').focus()
})
$('prev').onclick = () => turnPage('left')
$('next').onclick = () => turnPage('right')
$('return-link').onclick = () => navigate(() => returnToText(active))
$('contents').onclick = () => {
  $('toc').showModal()
  resetSentenceHint()
}
$('settings').onclick = () => {
  $('prefs').showModal()
  resetSentenceHint()
}
$('toc').addEventListener('close', resetSentenceHint)
$('prefs').addEventListener('close', resetSentenceHint)
$('size').onchange = updatePrefs
$('size').oninput = () => { $('size-value').value = $('size').value + ' px' }
$('theme').onchange = updatePrefs
$('sentence').onclick = () => {
  if (active?.sentenceMode && !window.getSelection()?.toString()) void turnPage('right')
}
$('sentence').addEventListener('pointerdown', resetSentenceHint)
$('sentence').addEventListener('scroll', resetSentenceHint, { passive: true })
document.addEventListener('visibilitychange', resetSentenceHint)
$('reading-mode').onchange = () => {
  void navigate(async () => {
    const reader = active
    const target = (reader.sentenceMode ? reader.sentences.location : reader.view.lastLocation)?.cfi
    if (await showReadingMode(reader, $('reading-mode').value, target)) {
      prefs.mode = reader.sentenceMode ? 'sentence' : 'page'
    }
    savePrefs()
  })
}
$('export').onclick = () => task(exportProgress)
$('import').onclick = () => $('progress-file').click()
$('progress-file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) void task(() => importProgress(file))
}
document.querySelector('#reader > header').addEventListener('touchmove', event => {
  if (event.touches.length === 1 && event.cancelable) event.preventDefault()
}, { passive: false })
document.addEventListener('keydown', keys)
applyPrefs()
void task(renderShelf)

const blockTags = new Set('p div li dt dd h1 h2 h3 h4 h5 h6 blockquote pre td th section article figcaption'.split(' '))
const ignored = 'script, style, noscript, svg, template, [hidden], [aria-hidden="true"]'

function splitSentences(doc, segmenter) {
  const sentences = []
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  let block
  let chunks = []
  let content = ''

  function flush() {
    let first = 0
    for (const { segment, index } of segmenter.segment(content)) {
      const start = index + segment.length - segment.trimStart().length
      const end = index + segment.trimEnd().length
      if (start >= end) continue
      while (chunks[first].end <= start) first++
      const parts = []
      for (let i = first; i < chunks.length && chunks[i].start < end; i++) {
        const { node, start: offset } = chunks[i]
        parts.push({
          text: node.data.slice(Math.max(start - offset, 0), end - offset),
          link: node.parentElement.closest('a[href]'),
        })
      }
      const range = doc.createRange()
      range.setStart(chunks[first].node, start - chunks[first].start)
      range.collapse(true)
      sentences.push({ range, parts })
    }
    content = ''
    chunks = []
  }

  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.parentElement.closest(ignored)) continue
    let parent = node.parentElement
    while (parent !== doc.body && !blockTags.has(parent.localName)) parent = parent.parentElement
    if (parent !== block) {
      flush()
      block = parent
    }
    chunks.push({ node, start: content.length, end: content.length + node.length })
    content += node.data
  }
  flush()
  return sentences
}

export class SentenceReader {
  constructor(view, panel) {
    this.view = view
    this.panel = panel
    this.segmenter = new Intl.Segmenter(view.language.canonical, { granularity: 'sentence' })
  }

  async load(index) {
    if (this.section?.index === index) return this.section
    const doc = await this.view.book.sections[index]?.createDocument?.()
    return { index, doc, sentences: doc?.body ? splitSentences(doc, this.segmenter) : [] }
  }

  async goTo(target) {
    const resolved = this.view.resolveNavigation(target)
    const sections = this.view.book.sections
    if (!sections[resolved?.index]) return false
    for (let index = resolved.index; index < sections.length; index++) {
      if (index !== resolved.index && sections[index].linear === 'no') continue
      const section = await this.load(index)
      if (!section.sentences.length) continue
      const anchor = index === resolved.index ? resolved.anchor?.(section.doc) : null
      let position = 0
      if (anchor?.nodeType === Node.ELEMENT_NODE || anchor?.startContainer) {
        const point = anchor.cloneRange?.() ?? section.doc.createRange()
        const elementAnchor = !anchor.cloneRange
        if (elementAnchor) point.selectNodeContents(anchor)
        point.collapse(true)
        for (const [i, { range }] of section.sentences.entries()) {
          if (point.comparePoint(range.startContainer, range.startOffset) > 0) {
            if (elementAnchor) position = i
            break
          }
          position = i
        }
      }
      return this.show(section, position, 'navigation')
    }
    return false
  }

  async step(direction) {
    const { section, position } = this
    const next = position + direction
    if (section.sentences[next]) return this.show(section, next, 'page')
    const sections = this.view.book.sections
    for (let index = section.index + direction; sections[index]; index += direction) {
      if (sections[index].linear === 'no') continue
      const candidate = await this.load(index)
      if (candidate.sentences.length) {
        return this.show(candidate, direction > 0 ? 0 : candidate.sentences.length - 1, 'page')
      }
    }
    return false
  }

  show(section, position, reason) {
    this.section = section
    this.position = position
    const { index, sentences } = section
    const { range, parts } = sentences[position]
    const source = this.view.book.sections[index]
    const nodes = parts.map(part => {
      if (!part.link) return document.createTextNode(part.text)
      const href = part.link.getAttribute('href')
      const target = source.resolveHref?.(href) ?? href
      if (!target || this.view.book.isExternal?.(target)) return document.createTextNode(part.text)
      const link = document.createElement('a')
      link.href = '#'
      link.textContent = part.text
      link.onclick = event => {
        event.preventDefault()
        event.stopPropagation()
        this.view.dispatchEvent(new CustomEvent('link', {
          detail: { a: part.link, href: target }, cancelable: true,
        }))
      }
      return link
    })
    this.panel.replaceChildren(...nodes)
    this.panel.parentElement.scrollTop = 0

    const fractions = this.view.getSectionFractions()
    const start = fractions[index] ?? 0
    const end = fractions[index + 1] ?? start
    this.location = {
      cfi: this.view.getCFI(index, range),
      fraction: start + (end - start) * (position + 1) / sentences.length,
      section: { current: index },
      reason,
    }
    return this.location
  }
}

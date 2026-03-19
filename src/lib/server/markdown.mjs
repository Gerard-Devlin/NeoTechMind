import MarkdownIt from 'markdown-it'
import markdownItAnchor from 'markdown-it-anchor'
import markdownItAttrs from 'markdown-it-attrs'
import markdownItKatex from 'markdown-it-katex'
import markdownItTaskLists from 'markdown-it-task-lists'
import { codeToHtml } from 'shiki'

import { slugifyText } from './content.mjs'

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function buildHeadingId(value) {
  return slugifyText(value)
}

function normalizeHeadingText(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .replace(/\s+#+$/, '')
    .trim()
}

function preprocessMathBlocks(source) {
  const matrixEnvironments = new Set([
    'matrix',
    'pmatrix',
    'bmatrix',
    'Bmatrix',
    'vmatrix',
    'Vmatrix',
    'smallmatrix'
  ])

  function normalizeMathEnvironmentBlock(block) {
    if (!block) return []

    let text = block.lines.join('\n')
    const envName = block.envName

    if (!envName) {
      return block.lines
    }

    const escapedEnv = envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const endPattern = new RegExp(`\\\\end\\{${escapedEnv}\\}`)

    // Users occasionally paste `\end` without environment name; remove this broken line
    // and append a complete closing tag below.
    text = text.replace(/(^|\n)\s*\\end\s*(?=\n|$)/g, '$1')

    if (!endPattern.test(text)) {
      const suffix = text.endsWith('\n') ? '' : '\n'
      text = `${text}${suffix}\\end{${envName}}`
    }

    if (matrixEnvironments.has(envName)) {
      const bodyPattern = new RegExp(`\\\\begin\\{${escapedEnv}\\}([\\s\\S]*?)\\\\end\\{${escapedEnv}\\}`)
      const bodyMatch = text.match(bodyPattern)

      if (bodyMatch) {
        const rawBody = bodyMatch[1]
        const hasExplicitRowSeparator = /\\\\/.test(rawBody)

        if (!hasExplicitRowSeparator) {
          const rows = rawBody
            .split('\n')
            .map((row) => row.trim())
            .filter(Boolean)

          if (rows.length > 1) {
            const normalizedRows = rows.map((row, index) =>
              index < rows.length - 1 ? `${row} \\\\` : row
            )
            const normalizedBody = `\n${normalizedRows.join('\n')}\n`
            text = text.replace(rawBody, normalizedBody)
          }
        }
      }
    }

    return text.split('\n')
  }

  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
  const output = []
  let inFence = false
  let pendingMath = null

  const flushPendingMath = (forceWrap = false) => {
    if (!pendingMath) return

    const normalizedLines = normalizeMathEnvironmentBlock(pendingMath)

    if (forceWrap) {
      output.push('$$')
      output.push(...normalizedLines)
      output.push('$$')
    } else {
      output.push(...normalizedLines)
    }

    pendingMath = null
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (/^```/.test(trimmed)) {
      flushPendingMath(true)
      inFence = !inFence
      output.push(line)
      continue
    }

    if (inFence) {
      output.push(line)
      continue
    }

    const beginMatch = trimmed.match(/^(?:\$\$\s*)?\\begin\{([A-Za-z*]+)\}/)

    if (!pendingMath && beginMatch) {
      const hasLeadingDisplayMath = /^\$\$/.test(trimmed)
      const hasTrailingDisplayMath = /\$\$\s*$/.test(trimmed)
      let normalizedLine = line

      if (hasLeadingDisplayMath) {
        normalizedLine = normalizedLine.replace(/^(\s*)\$\$\s*/, '$1')
      }
      if (hasTrailingDisplayMath) {
        normalizedLine = normalizedLine.replace(/\s*\$\$\s*$/, '')
      }

      pendingMath = {
        envName: beginMatch[1],
        lines: [normalizedLine]
      }

      const escapedEnv = beginMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const closesEnvironmentInline = new RegExp(`\\\\end\\{${escapedEnv}\\}`).test(normalizedLine)
      if (closesEnvironmentInline || hasTrailingDisplayMath) {
        flushPendingMath(true)
      }
      continue
    }

    if (pendingMath) {
      const closesDisplayMath = /\$\$\s*$/.test(trimmed)

      if (trimmed === '$$') {
        output.push('$$')
        output.push(...normalizeMathEnvironmentBlock(pendingMath))
        output.push('$$')
        pendingMath = null
        continue
      }

      const normalizedLine = closesDisplayMath ? line.replace(/\s*\$\$\s*$/, '') : line
      pendingMath.lines.push(normalizedLine)

      if (closesDisplayMath) {
        flushPendingMath(true)
        continue
      }

      if (pendingMath.envName) {
        const escapedEnv = pendingMath.envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const endMatch = new RegExp(`\\\\end\\{${escapedEnv}\\}`).test(trimmed)
        if (endMatch) {
          flushPendingMath(true)
          continue
        }
      } else if (/\\end\{[A-Za-z*]+\}/.test(trimmed)) {
        flushPendingMath(true)
        continue
      }

      continue
    }

    output.push(line)
  }

  flushPendingMath(true)

  return normalizeDollarMathDelimiters(
    output
    .join('\n')
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_, formula) => `$$\n${formula.trim()}\n$$`)
    .replace(/\\\(((?:\\.|[^\\)])*?)\\\)/g, (_, formula) => `$${formula.trim()}$`)
  )
}

function normalizeDollarMathDelimiters(source) {
  return String(source || '')
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
      const normalized = String(formula || '').trim()
      if (!normalized) return ''
      return `$$\n${normalized}\n$$`
    })
    .replace(/(^|[^\\$])\$(?!\$)([^$\n]*?)\$(?!\$)/gm, (_full, prefix, formula) => {
      const normalized = String(formula || '').trim()
      if (!normalized) return prefix
      return `${prefix}$${normalized}$`
    })
}

function buildInlineToc(headings) {
  if (!headings.length) return ''

  const minDepth = Math.min(...headings.map((heading) => heading.depth))
  let html = '<nav class="bb-inline-toc not-prose"><p class="bb-inline-toc-title">TABLE OF CONTENTS</p>'
  let currentDepth = minDepth - 1

  for (const heading of headings) {
    const depth = Math.max(minDepth, heading.depth)

    while (currentDepth < depth) {
      html += '<ul>'
      currentDepth += 1
    }

    while (currentDepth > depth) {
      html += '</li></ul>'
      currentDepth -= 1
    }

    if (html.endsWith('</a>')) {
      html += '</li>'
    }

    html += `<li><a href="#${heading.slug}">${escapeHtml(heading.text)}</a>`
  }

  while (currentDepth >= minDepth) {
    html += '</li></ul>'
    currentDepth -= 1
  }

  html += '</nav>'
  return html
}

function getIndent(line) {
  const match = line.match(/^\s*/)
  return match ? match[0].length : 0
}

function dedent(lines, indent) {
  return lines.map((line) => {
    if (!line.trim()) return ''
    return line.slice(Math.min(indent, getIndent(line)))
  })
}

function splitTitle(marker) {
  const match = marker.match(/^(?<kind>!!!|\?\?\?\+?)(?<rest>.*)$/)
  if (!match?.groups) return null

  const raw = match.groups.rest.trim()
  if (!raw) {
    return { style: 'note', title: '', foldable: false, open: true }
  }

  const titleMatch = raw.match(/^(?<type>[^\s"]+)\s*(?:"(?<title>.*)")?$/)
  const type = titleMatch?.groups?.type || 'note'
  const title = titleMatch?.groups?.title || ''
  const foldable = match.groups.kind.startsWith('???')
  const open = !match.groups.kind.endsWith('+')
  return { style: type.toLowerCase(), title, foldable, open }
}

function normalizeLanguage(rawInfo) {
  const lang = String(rawInfo || '').trim().split(/\s+/)[0]?.toLowerCase() || 'text'
  if (lang === 'c++') return 'cpp'
  if (lang === 'plaintext') return 'text'
  return lang
}

function wrapHighlightedCode(html) {
  return html
    .replace(/\sstyle="[^"]*"/, '')
    .replace(/^<pre class="shiki/, '<div class="astro-code shiki')
    .replace(/><code/, '><pre><code')
    .replace(/<\/code><\/pre>$/, '</code></pre></div>')
}

function injectLanguageTag(html, language) {
  if (!language) return html
  const tag = `<span class="language ps-1 pe-3 text-sm bg-muted text-muted-foreground">${escapeHtml(language)}</span>`
  return html.replace(/<\/div>$/, `${tag}</div>`)
}

async function highlightCodeBlock(content, rawInfo) {
  const language = normalizeLanguage(rawInfo)

  try {
    const html = await codeToHtml(content, {
      lang: language,
      themes: {
        light: 'github-light',
        dark: 'github-dark'
      }
    })

    return injectLanguageTag(wrapHighlightedCode(html), language)
  } catch {
    return injectLanguageTag(
      `<div class="astro-code"><pre><code>${escapeHtml(content)}</code></pre></div>`,
      language
    )
  }
}

function getTokenSourceLine(token) {
  if (!Array.isArray(token?.map)) return null
  const line = Number(token.map[0]) + 1
  return Number.isFinite(line) && line > 0 ? line : null
}

function setTokenSourceLineAttr(token) {
  const line = getTokenSourceLine(token)
  if (!line) return null
  token.attrSet('data-source-line', String(line))
  return line
}

function createMarkdownEngine(codeBlocks) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true
  })

  md.use(markdownItAnchor, {
    level: [1, 2, 3, 4, 5, 6],
    slugify: buildHeadingId,
    permalink: markdownItAnchor.permalink.linkInsideHeader({
      class: 'anchor',
      symbol: '#',
      placement: 'after',
      ariaHidden: true
    })
  })
  md.use(markdownItAttrs)
  md.use(markdownItKatex)
  md.use(markdownItTaskLists, { enabled: true, label: true, labelAfter: true })

  const blockTokenTypes = [
    'paragraph_open',
    'heading_open',
    'blockquote_open',
    'bullet_list_open',
    'ordered_list_open',
    'table_open',
    'hr',
    'code_block'
  ]

  blockTokenTypes.forEach((type) => {
    const fallbackRule =
      md.renderer.rules[type] ||
      ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))

    md.renderer.rules[type] = (tokens, index, options, env, self) => {
      setTokenSourceLineAttr(tokens[index])
      return fallbackRule(tokens, index, options, env, self)
    }
  })

  const defaultImageRenderer =
    md.renderer.rules.image ||
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))

  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index]
    const classIndex = token.attrIndex('class')

    if (classIndex < 0) {
      token.attrPush(['class', 'zoomable'])
    } else {
      const current = token.attrs?.[classIndex]?.[1] || ''
      const classes = new Set(current.split(/\s+/).filter(Boolean))
      classes.add('zoomable')
      token.attrs[classIndex][1] = [...classes].join(' ')
    }

    return defaultImageRenderer(tokens, index, options, env, self)
  }

  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    const info = (token.info || '').trim()
    const language = normalizeLanguage(info)
    const sourceLine = getTokenSourceLine(token)
    const sourceAttr = sourceLine ? ` data-source-line="${sourceLine}"` : ''

    if (language === 'mermaid') {
      return `<div class="mermaid"${sourceAttr}>${escapeHtml(token.content.trim())}</div>`
    }

    const placeholder = `<!--BB_CODE_BLOCK_${codeBlocks.length}-->`
    codeBlocks.push(highlightCodeBlock(token.content, info))
    return `<div class="bb-code-block"${sourceAttr}>${placeholder}</div>`
  }

  return md
}

async function renderMarkdownChunk(source) {
  const codeBlocks = []
  const md = createMarkdownEngine(codeBlocks)
  let html = md.render(source)

  if (codeBlocks.length > 0) {
    const resolvedBlocks = await Promise.all(codeBlocks)
    resolvedBlocks.forEach((block, index) => {
      html = html.replace(`<!--BB_CODE_BLOCK_${index}-->`, block)
    })
  }

  return html
}

async function renderTabs(renderNestedMarkdown, tabGroup) {
  const groupId = `tabs-${Math.random().toString(36).slice(2, 10)}`
  const buttons = tabGroup
    .map(
      (tab, index) =>
        `<button type="button" class="bb-tab-trigger${index === 0 ? ' is-active' : ''}" data-tab-target="${groupId}-${index}">${escapeHtml(tab.title)}</button>`
    )
    .join('')

  const panels = []
  for (const [index, tab] of tabGroup.entries()) {
    const inner = await renderNestedMarkdown(tab.body.join('\n'))
    panels.push(
      `<section class="bb-tab-panel${index === 0 ? ' is-active' : ''}" id="${groupId}-${index}">${inner.html}</section>`
    )
  }

  return `<div class="bb-tabs" data-bb-tabs><div class="bb-tab-list">${buttons}</div>${panels.join('')}</div>`
}

async function renderAdmonition(renderNestedMarkdown, header, bodyLines) {
  const parsed = splitTitle(header) || { style: 'note', title: '', foldable: false, open: true }
  const title = parsed.title || parsed.style.toUpperCase()
  const rendered = await renderNestedMarkdown(bodyLines.join('\n'))
  const inner = `<div class="bb-callout-title">${escapeHtml(title)}</div><div class="bb-callout-body">${rendered.html}</div>`

  if (parsed.foldable) {
    return `<details class="bb-callout bb-callout-${parsed.style}" ${parsed.open ? 'open' : ''}><summary>${escapeHtml(title)}</summary><div class="bb-callout-body">${rendered.html}</div></details>`
  }

  return `<aside class="bb-callout bb-callout-${parsed.style}">${inner}</aside>`
}

function isTocMarker(line) {
  return /^\uFEFF?\[toc\]$/i.test(line.trim())
}

async function renderCompositeMarkdown(source, tocHtml = '') {
  const lines = preprocessMathBlocks(source).split('\n')
  const output = []
  let buffer = []

  const flush = async () => {
    if (!buffer.length) return
    output.push(await renderMarkdownChunk(buffer.join('\n')))
    buffer = []
  }

  const renderNestedMarkdown = async (value) =>
    renderCompositeMarkdown(value, buildInlineToc(extractHeadings(value)))

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (isTocMarker(line)) {
      await flush()
      if (tocHtml) {
        output.push(tocHtml)
      }
      continue
    }

    if (/^(!!!|\?\?\?\+?)/.test(trimmed)) {
      await flush()
      const baseIndent = getIndent(line)
      const body = []
      index += 1

      while (index < lines.length) {
        const candidate = lines[index]
        const candidateIndent = getIndent(candidate)
        if (candidate.trim() && candidateIndent <= baseIndent) {
          index -= 1
          break
        }
        body.push(candidate)
        index += 1
      }

      const dedented = dedent(body, baseIndent + 4)
      output.push(await renderAdmonition(renderNestedMarkdown, trimmed, dedented))
      continue
    }

    if (/^===\s+"(.+)"\s*$/.test(trimmed)) {
      await flush()
      const tabs = []
      let cursor = index

      while (cursor < lines.length) {
        const tabLine = lines[cursor].trim()
        const tabMatch = tabLine.match(/^===\s+"(.+)"\s*$/)
        if (!tabMatch) break

        const baseIndent = getIndent(lines[cursor])
        const body = []
        cursor += 1

        while (cursor < lines.length) {
          const candidate = lines[cursor]
          if (
            candidate.trim() &&
            getIndent(candidate) <= baseIndent &&
            !candidate.trim().startsWith('=== ')
          ) {
            break
          }
          if (candidate.trim().startsWith('=== ') && getIndent(candidate) <= baseIndent) {
            break
          }
          body.push(candidate)
          cursor += 1
        }

        tabs.push({
          title: tabMatch[1],
          body: dedent(body, baseIndent + 4)
        })
      }

      index = cursor - 1
      output.push(await renderTabs(renderNestedMarkdown, tabs))
      continue
    }

    buffer.push(line)
  }

  await flush()

  const normalized = output
    .join('\n')
    .replace(/<p><\/p>/g, '')
    .replace(/<p>\s*\[TOC\]\s*<\/p>/gi, tocHtml)
    .replace(/<p>\s*\[toc\]\s*<\/p>/gi, tocHtml)

  return {
    html: normalized,
    hasMermaid: normalized.includes('class="mermaid"')
  }
}

export function extractHeadings(source) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true
  })
  const headings = []
  const tokens = md.parse(preprocessMathBlocks(source), {})

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'heading_open') continue

    const inlineToken = tokens[index + 1]
    const text = normalizeHeadingText(inlineToken?.content || '')
    const depth = Number(token.tag.replace('h', ''))

    if (!text || Number.isNaN(depth)) continue

    headings.push({
      depth,
      slug: buildHeadingId(text),
      text
    })
  }

  return headings
}

export async function renderMarkdown(source) {
  const headings = extractHeadings(source)
  const rendered = await renderCompositeMarkdown(source, buildInlineToc(headings))
  return {
    ...rendered,
    html: rendered.html.replace(/\uFEFF?\[TOC\]/gi, ''),
    headings
  }
}

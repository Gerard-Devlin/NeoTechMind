import { basename, extname } from 'node:path'

import MarkdownIt from 'markdown-it'
import markdownItAnchor from 'markdown-it-anchor'
import markdownItAttrs from 'markdown-it-attrs'
import markdownItTaskLists from 'markdown-it-task-lists'
import katex from 'katex'
import { codeToHtml } from 'shiki'

import { getMediaMetadataByPaths, slugifyText } from './content.mjs'

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const ATTACHMENT_IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp'
])

function normalizeAttachmentPath(value) {
  const raw = decodeHtmlEntities(String(value || '').trim())
  if (!raw) return ''

  let normalized = raw
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .split('#')[0]
    .split('?')[0]

  if (!normalized) return ''

  try {
    normalized = decodeURI(normalized)
  } catch {}

  return normalized.startsWith('/uploads/') || normalized.startsWith('/imports/techmind/') ? normalized : ''
}

function shouldRenderAttachmentCard(path, mimeType = '') {
  const extension = extname(path).toLowerCase()
  if (extension && ATTACHMENT_IMAGE_EXTENSIONS.has(extension)) return false
  if (!extension && String(mimeType || '').toLowerCase().startsWith('image/')) return false
  return true
}

function stripHtmlTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function formatAttachmentSize(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '-'
  if (value < 1024) return `${value} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let scaled = value / 1024
  let unitIndex = 0

  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024
    unitIndex += 1
  }

  const formatted = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)
  return `${formatted.replace(/\.0$/, '')} ${units[unitIndex]}`
}

function formatAttachmentDate(value) {
  const date = new Date(String(value || ''))
  if (Number.isNaN(date.getTime())) return '-'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

function parseAttachmentAnchorsFromParagraph(innerHtml) {
  const anchorPattern = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const anchors = []
  let residual = String(innerHtml || '')
  let match = null

  while ((match = anchorPattern.exec(innerHtml))) {
    const href = String(match[1] || '')
    const inner = String(match[2] || '')
    if (/<img\b/i.test(inner)) return []

    const path = normalizeAttachmentPath(href)
    if (!path || !shouldRenderAttachmentCard(path)) return []
    anchors.push({ path, inner })
    residual = residual.replace(match[0], '')
  }

  if (anchors.length === 0) return []

  // Only transform pure attachment paragraphs.
  const cleanedResidual = residual
    .replace(/<br\s*\/?>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, '')
  return cleanedResidual ? [] : anchors
}

function collectStandaloneAttachmentPaths(html) {
  const paragraphPattern = /<p\b[^>]*>([\s\S]*?)<\/p>/gi
  const paths = new Set()
  let match = null

  while ((match = paragraphPattern.exec(html))) {
    const anchors = parseAttachmentAnchorsFromParagraph(match[1] || '')
    for (const anchor of anchors) {
      paths.add(anchor.path)
    }
  }

  return [...paths]
}

function renderAttachmentCardsInHtml(html, metadataByPath) {
  const downloadIcon =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2a1 1 0 0 1 1 1v7.1l2.45-2.46a1 1 0 1 1 1.42 1.42l-4.16 4.17a1 1 0 0 1-1.42 0L5.13 9.06a1 1 0 0 1 1.42-1.42L9 10.1V3a1 1 0 0 1 1-1Zm-6 13a1 1 0 0 1 1 1v.5c0 .28.22.5.5.5h9c.28 0 .5-.22.5-.5V16a1 1 0 1 1 2 0v.5A2.5 2.5 0 0 1 14.5 19h-9A2.5 2.5 0 0 1 3 16.5V16a1 1 0 0 1 1-1Z"/></svg>'

  const renderAttachmentCard = (path, anchorInner) => {
    const metadata = metadataByPath.get(path) || null
    if (!path || !shouldRenderAttachmentCard(path, metadata?.mime_type || '')) return ''

    const fileName = basename(path) || 'attachment'
    const extension = extname(fileName).toLowerCase()
    const extensionLabel = extension ? extension : metadata?.mime_type ? `.${metadata.mime_type}` : '.file'
    const rawText = stripHtmlTags(anchorInner)
    const fallbackLabel = extension ? fileName.slice(0, -extension.length) : fileName
    const label =
      rawText && rawText !== path && rawText !== fileName
        ? rawText.replace(new RegExp(`${extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').trim() ||
          fallbackLabel
        : fallbackLabel

    const typeText = extension ? extension.slice(1).toUpperCase().slice(0, 5) : 'FILE'
    const typeClass = extension === '.pdf' ? ' is-pdf' : ''
    const sizeText = formatAttachmentSize(metadata?.size_bytes)
    const dateText = formatAttachmentDate(metadata?.updated_at)
    const escapedPath = escapeHtml(path)

    return `<div class="bb-attachment-card not-prose"><span class="bb-attachment-type${typeClass}">${escapeHtml(typeText)}</span><div class="bb-attachment-main"><a class="bb-attachment-name" href="${escapedPath}">${escapeHtml(label || fallbackLabel)}</a><p class="bb-attachment-ext">${escapeHtml(extensionLabel)}</p></div><p class="bb-attachment-size">${escapeHtml(sizeText)}</p><p class="bb-attachment-date">${escapeHtml(dateText)}</p><div class="bb-attachment-actions"><a class="bb-attachment-action" href="${escapedPath}" download="${escapeHtml(fileName)}" aria-label="Download ${escapeHtml(fileName)}">${downloadIcon}</a></div></div>`
  }

  return html.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (full, inner) => {
    const anchors = parseAttachmentAnchorsFromParagraph(inner)
    if (anchors.length === 0) return full

    const cards = anchors
      .map((item) => renderAttachmentCard(item.path, item.inner))
      .filter(Boolean)
      .join('')

    return cards || full
  })
}

function buildHeadingId(value) {
  return slugifyText(normalizeHeadingIdInput(value))
}

function normalizeHeadingText(value) {
  return String(value)
    // Keep link text but remove target URLs from markdown links.
    .replace(/!?\[([^\]]*?)\]\((?:\\.|[^\\)])*\)/g, '$1')
    // Remove auto-link URLs inside angle brackets and bare URLs.
    .replace(/<https?:\/\/[^>\s]+>/gi, '')
    .replace(/\bhttps?:\/\/[^\s)]+/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .replace(/\s+#+$/, '')
    .trim()
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function extractKatexAnnotations(value) {
  const source = String(value || '')
  const matches = source.matchAll(
    /<annotation\b[^>]*encoding=(['"])application\/x-tex\1[^>]*>([\s\S]*?)<\/annotation>/gi
  )
  const formulas = []

  for (const match of matches) {
    const formula = decodeHtmlEntities(match[2] || '').trim()
    if (formula) {
      formulas.push(`$${formula}$`)
    }
  }

  return formulas
}

function normalizeHeadingIdInput(value) {
  const raw = String(value || '')
  const annotations = extractKatexAnnotations(raw).join(' ')
  const withoutTags = decodeHtmlEntities(raw.replace(/<[^>]*>/g, ' '))
  return normalizeHeadingText(`${withoutTags} ${annotations}`)
}

function extractHeadingTextFromInlineTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return ''
  const parts = []
  let katexSpanDepth = 0
  let inTexAnnotation = false

  const countMatches = (value, pattern) => (String(value || '').match(pattern) || []).length

  for (const token of tokens) {
    if (!token) continue

    if (token.type === 'html_inline' || token.type === 'html_block') {
      const raw = String(token.content || '')

      if (
        katexSpanDepth === 0 &&
        /<span\b[^>]*class=(['"])[^"']*\bkatex(?:-display)?\b[^"']*\1/i.test(raw)
      ) {
        katexSpanDepth += countMatches(raw, /<span\b/gi) - countMatches(raw, /<\/span>/gi)
        if (katexSpanDepth <= 0) katexSpanDepth = 1
      } else if (katexSpanDepth > 0) {
        if (/<annotation\b[^>]*encoding=(['"])application\/x-tex\1/i.test(raw)) {
          inTexAnnotation = true
        }
        if (/<\/annotation>/i.test(raw)) {
          inTexAnnotation = false
        }
        katexSpanDepth += countMatches(raw, /<span\b/gi) - countMatches(raw, /<\/span>/gi)
        if (katexSpanDepth <= 0) {
          katexSpanDepth = 0
          inTexAnnotation = false
        }
        continue
      }

      const annotations = extractKatexAnnotations(raw)
      if (annotations.length > 0) {
        parts.push(...annotations)
        continue
      }

      const text = decodeHtmlEntities(raw.replace(/<[^>]*>/g, ' '))
      if (text.trim()) parts.push(text)
      continue
    }

    if (token.type === 'text' || token.type === 'code_inline') {
      const content = String(token.content || '')
      if (katexSpanDepth > 0 && !inTexAnnotation) continue
      if (content) parts.push(content)
      continue
    }

    if (token.type === 'image') {
      const alt = String(token.content || token.attrGet?.('alt') || '')
      if (alt) parts.push(alt)
      continue
    }

    if (typeof token.content === 'string' && token.content.trim()) {
      if (katexSpanDepth > 0 && !inTexAnnotation) continue
      parts.push(token.content)
    }
  }

  return normalizeHeadingText(parts.join(' '))
}

const LATEX_COMMAND_PATTERN =
  /\\(?:sum|prod|frac|dfrac|tfrac|sqrt|int|lim|log|ln|sin|cos|tan|max|min|gcd|mid|leq|geq|neq|omega|alpha|beta|gamma|delta|theta|lambda|pi|sigma|mu)\b/

function isFenceDelimiter(line) {
  return /^(```|~~~)/.test(String(line || '').trim())
}

function findMatchingBraceEnd(input, startIndex) {
  if (input[startIndex] !== '{') return -1
  let depth = 0

  for (let index = startIndex; index < input.length; index += 1) {
    const char = input[index]

    if (char === '\\') {
      index += 1
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

function normalizeIncompleteFracCommands(input) {
  const value = String(input || '')
  let output = ''
  let index = 0

  while (index < value.length) {
    const fragment = value.slice(index)
    const commandMatch = fragment.match(/^\\(?:d|t)?frac\b/)

    if (!commandMatch) {
      output += value[index]
      index += 1
      continue
    }

    const command = commandMatch[0]
    output += command
    index += command.length

    while (index < value.length && /\s/.test(value[index])) {
      output += value[index]
      index += 1
    }

    if (value[index] !== '{') {
      continue
    }

    const numeratorEnd = findMatchingBraceEnd(value, index)
    if (numeratorEnd < 0) {
      output += value.slice(index)
      break
    }

    output += value.slice(index, numeratorEnd + 1)
    index = numeratorEnd + 1

    while (index < value.length && /\s/.test(value[index])) {
      output += value[index]
      index += 1
    }

    if (value[index] === '{') {
      const denominatorEnd = findMatchingBraceEnd(value, index)
      if (denominatorEnd < 0) {
        output += value.slice(index)
        break
      }
      output += value.slice(index, denominatorEnd + 1)
      index = denominatorEnd + 1
      continue
    }

    output += '{}'
  }

  return output
}

function isLikelyDisplayMathContent(formula) {
  const normalized = normalizeIncompleteFracCommands(String(formula || '').trim())
  if (!normalized) return false

  const hasInlineMath = /(^|[^\\])\$(?!\$).+?(^|[^\\])\$(?!\$)/s.test(normalized)
  const hasCjk = /[\u3400-\u9fff]/.test(normalized)

  if (hasInlineMath && hasCjk) return false
  if (/\\begin\{[A-Za-z*]+\}|\\end\{[A-Za-z*]+\}/.test(normalized)) return true

  return (
    LATEX_COMMAND_PATTERN.test(normalized) ||
    /\\[A-Za-z]+/.test(normalized) ||
    /[_^]/.test(normalized) ||
    /[=<>]/.test(normalized)
  )
}

function normalizeEscapedMathDelimiters(source) {
  return String(source || '')
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_, formula) => {
      const normalized = normalizeIncompleteFracCommands(String(formula || '').trim())
      if (!normalized) return ''
      return `$$\n${normalized}\n$$`
    })
    .replace(/\\\(((?:\\.|[^\\)])*?)\\\)/g, (_, formula) => {
      const normalized = normalizeIncompleteFracCommands(String(formula || '').trim())
      if (!normalized) return ''
      return `$${normalized}$`
    })
}

function normalizeBrokenEnvironmentDirectives(source) {
  return String(source || '')
    .replace(/(^|\n)([ \t]*)\\{2}(begin|end)\s*\{([A-Za-z*]+)\}/g, (_full, prefix, indent, kind, envName) => {
      return `${prefix}${indent}\\${kind}{${envName}}`
    })
    .replace(/\\(begin|end)\s*\n\s*\{([A-Za-z*]+)\}/g, (_full, kind, envName) => {
      return `\\${kind}{${envName}}`
    })
    .replace(/\\(begin|end)\s+\{([A-Za-z*]+)\}/g, (_full, kind, envName) => {
      return `\\${kind}{${envName}}`
    })
}

function splitInlineEnvironmentStarts(source) {
  const lines = String(source || '').split('\n')
  const output = []

  for (const line of lines) {
    let current = line
    let safety = 0

    while (safety < 12) {
      safety += 1
      const beginIndex = current.indexOf('\\begin{')
      if (beginIndex <= 0) break

      const prefix = current.slice(0, beginIndex)
      // Avoid splitting if this begin appears inside an inline math fragment.
      if (prefix.includes('$')) break

      if (prefix.trim()) {
        output.push(prefix.trimEnd())
      }

      current = current.slice(beginIndex).trimStart()
    }

    output.push(current)
  }

  return output.join('\n')
}

function isLikelyStandaloneEquationLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed || trimmed.includes('$')) return false
  if (/^(#{1,6}\s|>\s|[-*+]\s|```|~~~|\d+\.\s|\|)/.test(trimmed)) return false

  const hasMathToken =
    LATEX_COMMAND_PATTERN.test(trimmed) || /\\[A-Za-z]+/.test(trimmed) || /[_^]/.test(trimmed)
  const hasEquationOp = /[=<>]/.test(trimmed)
  const hasCjk = /[\u3400-\u9fff]/.test(trimmed)

  return hasMathToken && hasEquationOp && !hasCjk
}

function wrapStandaloneEquationLines(source) {
  const lines = String(source || '').split('\n')
  const output = []
  let inDisplay = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '$$') {
      inDisplay = !inDisplay
      output.push(line)
      continue
    }

    if (inDisplay || !isLikelyStandaloneEquationLine(line)) {
      output.push(line)
      continue
    }

    output.push('$$')
    output.push(normalizeIncompleteFracCommands(trimmed))
    output.push('$$')
  }

  return output.join('\n')
}

function normalizeMathEnvironmentBlocks(source) {
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

    text = text.replace(/\\{2}(begin|end)\{([A-Za-z*]+)\}/g, (_full, kind, name) => {
      return `\\${kind}{${name}}`
    })

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

  const lines = String(source || '').split('\n')
  const output = []
  let pendingMath = null
  let inExplicitDisplayBlock = false

  const flushPendingMath = () => {
    if (!pendingMath) return

    const normalizedLines = normalizeMathEnvironmentBlock(pendingMath)
    output.push('$$')
    output.push(...normalizedLines)
    output.push('$$')
    pendingMath = null
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '$$') {
      if (pendingMath) {
        flushPendingMath()
      }
      inExplicitDisplayBlock = !inExplicitDisplayBlock
      output.push(line)
      continue
    }

    if (inExplicitDisplayBlock) {
      output.push(line)
      continue
    }

    const beginMatch = trimmed.match(/^(?:\$\$\s*)?\\{1,2}begin\{([A-Za-z*]+)\}/)

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

      normalizedLine = normalizedLine.replace(/\\{2}begin\{([A-Za-z*]+)\}/, (_full, name) => {
        return `\\begin{${name}}`
      })

      pendingMath = {
        envName: beginMatch[1],
        lines: [normalizedLine]
      }

      const escapedEnv = beginMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const closesEnvironmentInline = new RegExp(`\\\\{1,2}end\\{${escapedEnv}\\}`).test(normalizedLine)
      if (closesEnvironmentInline || hasTrailingDisplayMath) {
        flushPendingMath()
      }
      continue
    }

    if (pendingMath) {
      const closesDisplayMath = /\$\$\s*$/.test(trimmed)

      if (trimmed === '$$') {
        flushPendingMath()
        continue
      }

      const normalizedLine = closesDisplayMath ? line.replace(/\s*\$\$\s*$/, '') : line
      pendingMath.lines.push(normalizedLine)

      if (closesDisplayMath) {
        flushPendingMath()
        continue
      }

      if (pendingMath.envName) {
        const escapedEnv = pendingMath.envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const endMatch = new RegExp(`\\\\{1,2}end\\{${escapedEnv}\\}`).test(trimmed)
        if (endMatch) {
          flushPendingMath()
          continue
        }
      } else if (/\\{1,2}end\{[A-Za-z*]+\}/.test(trimmed)) {
        flushPendingMath()
        continue
      }

      continue
    }

    output.push(line)
  }

  flushPendingMath()
  return output.join('\n')
}

function finalizeDisplayFormula(rawFormula) {
  const normalized = normalizeIncompleteFracCommands(String(rawFormula || '').trim())
  if (!normalized) return []
  if (!isLikelyDisplayMathContent(normalized)) return [normalized]
  return ['$$', normalized, '$$']
}

function normalizeDisplayMathDelimiters(source) {
  const lines = String(source || '').split('\n')
  const output = []
  let inDisplay = false
  let displayBuffer = []

  const appendProcessedTail = (tail) => {
    if (!tail) return
    const normalizedTail = normalizeDisplayMathDelimiters(tail)
    output.push(...normalizedTail.split('\n'))
  }

  for (const line of lines) {
    if (inDisplay) {
      const closeIndex = line.indexOf('$$')

      if (closeIndex < 0) {
        displayBuffer.push(line)
        continue
      }

      displayBuffer.push(line.slice(0, closeIndex))
      output.push(...finalizeDisplayFormula(displayBuffer.join('\n')))
      displayBuffer = []
      inDisplay = false
      appendProcessedTail(line.slice(closeIndex + 2))
      continue
    }

    if (!line.includes('$$')) {
      output.push(line)
      continue
    }

    let cursor = 0
    let emittedAnySegment = false

    while (cursor < line.length) {
      const openIndex = line.indexOf('$$', cursor)

      if (openIndex < 0) {
        const tail = line.slice(cursor)
        if (tail) {
          output.push(tail)
          emittedAnySegment = true
        }
        break
      }

      const before = line.slice(cursor, openIndex)
      if (before.trim()) {
        output.push(before.trimEnd())
        emittedAnySegment = true
      }

      const closeIndex = line.indexOf('$$', openIndex + 2)

      if (closeIndex < 0) {
        inDisplay = true
        displayBuffer = [line.slice(openIndex + 2)]
        break
      }

      output.push(...finalizeDisplayFormula(line.slice(openIndex + 2, closeIndex)))
      emittedAnySegment = true
      cursor = closeIndex + 2
    }

    if (!emittedAnySegment && !inDisplay) {
      output.push('')
    }
  }

  if (inDisplay) {
    output.push(...finalizeDisplayFormula(displayBuffer.join('\n')))
  }

  return output.join('\n')
}

function normalizeInlineMathDelimiters(source) {
  return String(source || '').replace(/(^|[^\\$])\$(?!\$)([^$\n]*?)\$(?!\$)/gm, (_full, prefix, formula) => {
    const normalized = normalizeIncompleteFracCommands(String(formula || '').trim())
    if (!normalized) return prefix
    return `${prefix}$${normalized}$`
  })
}

function normalizeDollarMathDelimiters(source) {
  return normalizeInlineMathDelimiters(normalizeDisplayMathDelimiters(source))
}

function normalizeAlignmentEnvironments(source, displayMode) {
  let value = String(source || '').trim()
  if (!value) return value

  value = value
    .replace(/\\begin\{align\*?\}/g, '\\begin{aligned}')
    .replace(/\\end\{align\*?\}/g, '\\end{aligned}')

  const hasBeginEnv = /\\begin\{[A-Za-z*]+\}/.test(value)
  const hasEndEnv = /\\end\{[A-Za-z*]+\}/.test(value)
  const hasAlignmentMarker = /(^|[^\\])&/.test(value)

  if (displayMode && hasAlignmentMarker && !hasBeginEnv) {
    value = `\\begin{aligned}\n${value}\n\\end{aligned}`
  }

  const hasBeginAligned = /\\begin\{aligned\}/.test(value)
  const hasEndAligned = /\\end\{aligned\}/.test(value)

  if (hasBeginAligned && !hasEndAligned) {
    value = `${value}\n\\end{aligned}`
  } else if (!hasBeginAligned && hasEndAligned) {
    value = `\\begin{aligned}\n${value}`
  } else if (displayMode && hasEndEnv && !hasBeginEnv && hasAlignmentMarker) {
    value = `\\begin{aligned}\n${value}`
  } else if (displayMode && hasBeginEnv && !hasEndEnv) {
    value = `${value}\n\\end{aligned}`
  }

  return value
}

function renderMathExpression(formula, displayMode) {
  const normalized = normalizeAlignmentEnvironments(
    normalizeIncompleteFracCommands(String(formula || '').trim()),
    displayMode
  )
  if (!normalized) return ''

  try {
    return katex.renderToString(normalized, {
      displayMode,
      throwOnError: false,
      strict: 'ignore'
    })
  } catch {
    if (displayMode) {
      return `$$\n${normalized}\n$$`
    }
    return `$${normalized}$`
  }
}

function renderInlineMathSegments(line) {
  return String(line || '').replace(/(^|[^\\$])\$(?!\$)([^$\n]*?)\$(?!\$)/g, (_full, prefix, formula) => {
    const rendered = renderMathExpression(formula, false)
    if (!rendered) return prefix
    return `${prefix}${rendered}`
  })
}

function renderHeadingMathHtml(value) {
  const source = String(value || '')
  if (!source) return ''

  const pattern = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g
  let output = ''
  let lastIndex = 0
  let hasMath = false

  for (const match of source.matchAll(pattern)) {
    const matchIndex = match.index ?? 0
    const full = match[0] || ''
    const formula = String(match[1] ?? match[2] ?? '')

    output += escapeHtml(source.slice(lastIndex, matchIndex))

    const rendered = renderMathExpression(formula, false)
    if (rendered) {
      output += rendered
      hasMath = true
    } else {
      output += escapeHtml(full)
    }

    lastIndex = matchIndex + full.length
  }

  output += escapeHtml(source.slice(lastIndex))
  return hasMath ? output : ''
}

function renderMathMarkup(source) {
  const lines = String(source || '').split('\n')
  const output = []
  let inFence = false
  let inDisplayMath = false
  let displayBuffer = []

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      inFence = !inFence
      output.push(line)
      continue
    }

    if (inFence) {
      output.push(line)
      continue
    }

    if (inDisplayMath) {
      const closeIndex = line.indexOf('$$')

      if (closeIndex < 0) {
        displayBuffer.push(line)
        continue
      }

      displayBuffer.push(line.slice(0, closeIndex))
      output.push(renderMathExpression(displayBuffer.join('\n'), true))
      displayBuffer = []
      inDisplayMath = false

      const tail = line.slice(closeIndex + 2)
      output.push(renderInlineMathSegments(tail))
      continue
    }

    if (!line.includes('$$')) {
      output.push(renderInlineMathSegments(line))
      continue
    }

    let cursor = 0
    let transformed = ''

    while (cursor < line.length) {
      const openIndex = line.indexOf('$$', cursor)

      if (openIndex < 0) {
        transformed += renderInlineMathSegments(line.slice(cursor))
        break
      }

      transformed += renderInlineMathSegments(line.slice(cursor, openIndex))

      const closeIndex = line.indexOf('$$', openIndex + 2)

      if (closeIndex < 0) {
        inDisplayMath = true
        displayBuffer = [line.slice(openIndex + 2)]
        break
      }

      transformed += renderMathExpression(line.slice(openIndex + 2, closeIndex), true)
      cursor = closeIndex + 2
    }

    if (!inDisplayMath) {
      output.push(transformed)
    }
  }

  if (inDisplayMath) {
    output.push(renderMathExpression(displayBuffer.join('\n'), true))
  }

  return output.join('\n')
}

function normalizeMathTextChunk(source) {
  if (!source) return source

  let normalized = normalizeEscapedMathDelimiters(source)
  normalized = normalizeBrokenEnvironmentDirectives(normalized)
  normalized = normalizeDollarMathDelimiters(normalized)
  return normalized
}

function normalizeHeadingDisplayMath(source) {
  const lines = String(source || '').split('\n')
  const output = []
  let inFence = false

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      inFence = !inFence
      output.push(line)
      continue
    }

    if (inFence) {
      output.push(line)
      continue
    }

    const headingMatch = line.match(/^(\s{0,3}#{1,6}\s+)(.*)$/)
    if (!headingMatch) {
      output.push(line)
      continue
    }

    const prefix = headingMatch[1]
    const content = headingMatch[2].replace(
      /(?<!\\)\$\$([^\n]*?)(?<!\\)\$\$/g,
      (_full, formula) => `$${String(formula || '').trim()}$`
    )

    output.push(`${prefix}${content}`)
  }

  return output.join('\n')
}

function preprocessMathBlocks(source) {
  const normalizedSource = normalizeHeadingDisplayMath(String(source || '').replace(/\r\n/g, '\n'))
  const lines = normalizedSource.split('\n')
  const output = []
  let inFence = false
  let textBuffer = []

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) return
    output.push(...normalizeMathTextChunk(textBuffer.join('\n')).split('\n'))
    textBuffer = []
  }

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      if (!inFence) {
        flushTextBuffer()
      }

      inFence = !inFence
      output.push(line)
      continue
    }

    if (inFence) {
      output.push(line)
      continue
    }

    textBuffer.push(line)
  }

  flushTextBuffer()
  return output.join('\n')
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

    const headingLabel = heading.html || escapeHtml(heading.text)
    html += `<li><a href="#${heading.slug}">${headingLabel}</a>`
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

function isAdmonitionHeader(line) {
  const trimmed = String(line || '').trim()
  return /^(?:!!!|\?\?\?\+?)\s*[A-Za-z][\w-]*(?:\s+"[^"]*")?\s*$/.test(trimmed)
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
    getTokensText: (tokens) => extractHeadingTextFromInlineTokens(tokens),
    permalink: markdownItAnchor.permalink.linkInsideHeader({
      class: 'anchor',
      symbol: '#',
      placement: 'after',
      ariaHidden: true
    })
  })
  md.use(markdownItAttrs)
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
  let html = md.render(renderMathMarkup(source))

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

    if (isAdmonitionHeader(trimmed)) {
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
    const text =
      extractHeadingTextFromInlineTokens(inlineToken?.children || []) ||
      normalizeHeadingIdInput(inlineToken?.content || '')
    const depth = Number(token.tag.replace('h', ''))

    if (!text || Number.isNaN(depth)) continue

    const html = renderHeadingMathHtml(text)
    headings.push({
      depth,
      slug: buildHeadingId(text),
      text,
      ...(html ? { html } : {})
    })
  }

  return headings
}

export async function renderMarkdown(source) {
  const headings = extractHeadings(source)
  const rendered = await renderCompositeMarkdown(source, buildInlineToc(headings))
  const attachmentPaths = collectStandaloneAttachmentPaths(rendered.html)
  const attachmentMetadata = await getMediaMetadataByPaths(attachmentPaths)
  const metadataByPath = new Map(attachmentMetadata.map((item) => [item.file_path, item]))
  const htmlWithAttachmentCards = renderAttachmentCardsInHtml(rendered.html, metadataByPath)

  return {
    ...rendered,
    html: htmlWithAttachmentCards.replace(/\uFEFF?\[TOC\]/gi, ''),
    headings
  }
}

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { DbError } from './db.js'

/** Cache por sessão: WeakMap<ctx, Map<root, Map<basename, caminhos>>> */
const nameIndexCache = new WeakMap()

/**
 * Constrói (uma vez por raiz) um índice barato de nomes: basename em minúsculas
 * -> caminhos. Usa só `readdir` (sem `stat` por arquivo) — num Export de 181 mil
 * arquivos isso é a diferença entre ~1s e ~20s.
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
function buildNameIndex(root) {
  /** @type {Map<string, string[]>} */
  const index = new Map()
  /** @param {string} dir */
  const walk = dir => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name))
      } else if (entry.isFile() && !/^autopsy\.db(-wal|-shm)?$/i.test(entry.name)) {
        // não indexa o DB do case, mas indexa app dbs (msgstore.db, ChatStorage.sqlite...)
        const key = entry.name.toLowerCase()
        const list = index.get(key) ?? []
        list.push(join(dir, entry.name))
        index.set(key, list)
      }
    }
  }
  walk(root)
  return index
}

/**
 * @param {any} ctx
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
function getIndex(ctx, root) {
  let perCtx = nameIndexCache.get(ctx)
  if (!perCtx) {
    perCtx = new Map()
    nameIndexCache.set(ctx, perCtx)
  }
  if (!perCtx.has(root)) perCtx.set(root, buildNameIndex(root))
  return perCtx.get(root)
}

/**
 * Candidatos para um arquivo: casa por basename no índice e faz `stat` só nos
 * candidatos (o tamanho é checado depois, onde é barato).
 * @param {any} ctx
 * @param {string} root
 * @param {string} name - basename em minúsculas
 * @returns {Array<{ path: string, size: number }>}
 */
function candidatesFor(ctx, root, name) {
  const paths = getIndex(ctx, root).get(name) ?? []
  /** @type {Array<{ path: string, size: number }>} */
  const out = []
  for (const p of paths) {
    try {
      out.push({ path: p, size: statSync(p).size })
    } catch {
      /* arquivo desapareceu: ignora */
    }
  }
  return out
}

/**
 * Raízes de export a tentar: a configurada por env e o Export do próprio case
 * (o Autopsy cria `<caseDir>/Export` quando o perito exporta arquivos).
 * @param {any} ctx
 * @returns {string[]}
 */
function exportRoots(ctx) {
  /** @type {string[]} */
  const roots = []
  if (ctx.env.exportDir) roots.push(ctx.env.exportDir)
  if (ctx.active?.caseDir) {
    const auto = join(ctx.active.caseDir, 'Export')
    if (!roots.includes(auto)) roots.push(auto)
  }
  return roots.filter(r => existsSync(r))
}

/** @param {string} p @returns {string} */
export function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

/**
 * Valida um caminho explícito informado pelo agente contra as raízes de conteúdo
 * permitidas. Sem isso, `path` viraria leitura arbitrária de arquivos na máquina
 * (o server roda no host do Autopsy) — então só aceitamos dentro do Export do
 * case, do AUTOPSY_EXPORT_DIR ou do AUTOPSY_FILES_ROOT.
 *
 * @param {any} ctx
 * @param {string} candidate
 * @returns {{ source: string, path: string, verified: boolean }}
 */
export function resolveExplicitPath(ctx, candidate) {
  const p = resolve(candidate)
  const roots = [...exportRoots(ctx), ...(ctx.env.filesRoot ? [ctx.env.filesRoot] : [])]
  const allowed = roots.some(root => {
    const rel = relative(resolve(root), p)
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
  })
  if (!allowed) {
    throw new DbError(
      `Caminho fora das raízes de conteúdo permitidas (Export do case, AUTOPSY_EXPORT_DIR, AUTOPSY_FILES_ROOT): ${p}`
    )
  }
  if (!existsSync(p) || !statSync(p).isFile()) {
    throw new DbError(`Arquivo não existe ou não é um arquivo: ${p}`)
  }
  return { source: 'explicit_path', path: p, verified: false }
}

/**
 * Resolve o caminho físico do conteúdo de um arquivo do case, sem tocar no case.
 *
 * Ordem: (1) files_root (caminho direto), (2) Export — casando por nome+tamanho
 * e **confirmando por sha256** quando o DB tem o hash; sem confirmação, o
 * resultado volta marcado (`verified: false`) para o laudo saber.
 *
 * @param {any} ctx
 * @param {Record<string, any>} fileRow - linha de tsk_files
 * @returns {{ source: string, path: string, verified: boolean }
 *   | { ambiguous: true, candidates: string[] }
 *   | null}
 */
export function resolveContentPath(ctx, fileRow) {
  if (ctx.env.filesRoot) {
    const full = (fileRow.parent_path ?? '') + (fileRow.name ?? '')
    const p = resolve(join(ctx.env.filesRoot, ...full.split('/').filter(Boolean)))
    if (existsSync(p) && statSync(p).isFile()) {
      return { source: 'files_root', path: p, verified: false }
    }
  }

  const name = String(fileRow.name ?? '').toLowerCase()
  const sha = fileRow.sha256 ? String(fileRow.sha256).toLowerCase() : null
  const size = fileRow.size === null || fileRow.size === undefined ? null : Number(fileRow.size)
  if (!name) return null

  for (const root of exportRoots(ctx)) {
    const all = candidatesFor(ctx, root, name)
    const cands = size === null ? all : all.filter(c => c.size === size)
    if (!cands.length) continue
    if (sha) {
      for (const c of cands) {
        if (sha256File(c.path) === sha) {
          return { source: 'export_sha256', path: c.path, verified: true }
        }
      }
      continue // existe com o nome, mas o hash não bate: não é este arquivo
    }
    if (cands.length === 1) {
      return { source: 'export_nome_tamanho', path: cands[0].path, verified: false }
    }
  }

  // nome+tamanho sem hash disponível e mais de um candidato: não dá para decidir
  for (const root of exportRoots(ctx)) {
    const all = candidatesFor(ctx, root, name)
    const cands = size === null ? all : all.filter(c => c.size === size)
    if (cands.length > 1) {
      return { ambiguous: true, candidates: cands.map(c => c.path) }
    }
  }
  return null
}

/**
 * Leitura síncrona de um slice do arquivo.
 * @param {string} path
 * @param {number} offset
 * @param {number} length
 * @returns {Buffer}
 */
export function readSlice(path, offset, length) {
  const size = statSync(path).size
  const start = Math.min(offset, size)
  const end = Math.min(offset + length, size)
  const buf = Buffer.alloc(end - start)
  if (buf.length > 0) {
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
  }
  return buf
}

/**
 * Buffer legível direto (leitura completa com teto).
 * @param {string} path
 * @param {number} [maxBytes]
 */
export function readAll(path, maxBytes = 64 * 1024 * 1024) {
  const size = statSync(path).size
  if (size > maxBytes) {
    throw new DbError(
      `Arquivo grande demais (${size} bytes) para leitura completa. Use get_file_hex com offset/length para inspecionar partes, ou reduza o escopo.`
    )
  }
  return readFileSync(path)
}

/**
 * Extrai strings ASCII/UTF-8 de um buffer.
 * @param {Buffer} buf
 * @param {number} minLength
 * @param {number} maxResults
 * @returns {string[]}
 */
export function extractStrings(buf, minLength = 5, maxResults = 200) {
  const found = []
  let cur = []
  /** @param {number} b */
  const isPrintable = b => (b >= 0x20 && b <= 0x7e) || b === 0x09
  for (const b of buf) {
    if (isPrintable(b)) {
      cur.push(b)
    } else {
      if (cur.length >= minLength) {
        found.push(Buffer.from(cur).toString('latin1'))
        if (found.length >= maxResults) return found
      }
      cur = []
    }
  }
  if (cur.length >= minLength) found.push(Buffer.from(cur).toString('latin1'))
  return found
}

/**
 * Copia o arquivo resolvido para outPath (fora do case — verificado pelo chamador).
 * @param {string} src
 * @param {string} outPath
 * @returns {number} bytes escritos
 */
export function copyTo(src, outPath) {
  const buf = readFileSync(src)
  writeFileSync(outPath, buf)
  return buf.length
}

/** @param {string} p @returns {string} */
export function safeName(p) {
  return basename(p) || p
}

/** @param {string} a @param {string} b @returns {boolean} */
export function isInside(a, b) {
  const rel = relative(resolve(a), resolve(b))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

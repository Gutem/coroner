import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  copyTo,
  extractStrings,
  isInside,
  readAll,
  readSlice,
  resolveContentPath,
  resolveExplicitPath,
} from './content.js'
import { connectCase, DbError, openReadonly, openSqliteReadonly } from './db.js'
import { attrValue, dec, KNOWN_STATUS, META_TYPES, OBJECT_TYPES, ts } from './schema.js'

/**
 * @typedef {object} Ctx
 * @property {{ casesDir: string, exportDir: string | null, filesRoot: string | null }} env
 * @property {{ label: string | null, caseDir: string | null, dbPath: string | null }} active
 * @property {(casePath: string) => void} setActiveCase
 */

/** @param {any} payload */
const ok = payload => payload

/** @param {any[]} rows @returns {any[]} */
function keyLower(rows) {
  return rows.map(r => {
    /** @type {Record<string, any>} */
    const out = {}
    for (const [k, v] of Object.entries(r)) out[k.toLowerCase()] = v
    return out
  })
}

/**
 * Busca linha de tsk_files por obj_id.
 * @param {{ query: (sql: string, params?: import('bun:sqlite').SQLQueryBindings[]) => any[] }} h
 * @param {number} objId
 * @returns {Record<string, any> | null}
 */
function getFileRow(h, objId) {
  const rows = h.query('SELECT * FROM tsk_files WHERE obj_id = ?', [objId])
  return rows.length ? rows[0] : null
}

// ---------------------------------------------------------------------------
// TOOLS
// ---------------------------------------------------------------------------

/**
 * Deriva o nome do case a partir do caminho do autopsy.db.
 * Normaliza `\` para `/` antes de resolver, para funcionar em Windows e POSIX
 * (o path module do Node no macOS/Linux não trata `\` como separador).
 * @param {string} dbPath
 * @returns {string}
 */
export function caseNameFromDbPath(dbPath) {
  return basename(dirname(dbPath.replace(/\\/g, '/')))
}

/**
 * Lista os cases na base de diretórios (pastas contendo autopsy.db).
 * @param {Ctx} ctx
 * @param {{ baseDir?: string | null }} args
 */
export function listCases(ctx, args = {}) {
  const root = resolve(args.baseDir ?? ctx.env.casesDir)
  try {
    statSync(root)
  } catch {
    throw new DbError(
      `O diretório de cases não existe: ${root}. Configure AUTOPSY_CASES_DIR ou passe base_dir a esta tool.`
    )
  }
  /** @type {any[]} */
  const cases = []
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === 'autopsy.db') {
        const st = statSync(p)
        cases.push({
          case_name: caseNameFromDbPath(p),
          case_dir: dir,
          db_size_bytes: st.size,
          db_last_modified: ts(st.mtimeMs / 1000),
        })
      }
    }
  }
  walk(root, 1)
  return ok({
    base_dir: root,
    cases_found: cases.length,
    cases,
    hint: cases.length
      ? 'Use set_active_case com o case_dir para abrir um case.'
      : 'Nenhum autopsy.db encontrado. Verifique o caminho dos cases.',
  })
}

/**
 * Ativa um case para a sessão. Aceita pasta do case ou caminho do autopsy.db.
 * @param {Ctx} ctx
 * @param {{ casePath: string }} args
 */
export function setActiveCase(ctx, args) {
  ctx.setActiveCase(args.casePath)
  if (!ctx.active.dbPath) {
    throw new DbError('Falha ao ativar o case: nenhum dbPath definido.')
  }
  const h = openReadonly(ctx.active.dbPath)
  let ver = null
  try {
    const rows = h.query('SELECT schema_ver FROM tsk_db_info LIMIT 1')
    if (rows.length) ver = rows[0].schema_ver
  } catch {
    ver = null
  } finally {
    h.close()
  }
  return ok({
    status: 'ok',
    active_case: ctx.active.label,
    db: ctx.active.dbPath,
    schema_version: ver,
    mode: 'READ-ONLY (nenhuma escrita possível)',
  })
}

/**
 * Resumo do case ativo: metadata, data sources, contagens e breakdown de artifacts.
 * @param {Ctx} ctx
 * @param {object} _args
 */
export function getCaseSummary(ctx, _args = {}) {
  const h = connectCase(ctx)
  try {
    /** @type {Record<string, any>} */
    const summary = { case: ctx.active.label }

    const tables = new Set(h.listTables())
    /** @type {Map<string, any>} */
    const ext = new Map()
    if (tables.has('tsk_db_info_extended')) {
      for (const r of keyLower(h.query('SELECT name, value FROM tsk_db_info_extended'))) {
        // as chaves variam ("CaseName", "case_name", "SCHEMA_MAJOR_VERSION"):
        // normaliza para minúsculas sem pontuação antes de indexar
        ext.set(
          String(r.name)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, ''),
          r.value
        )
      }
    }
    const info = h.query('SELECT * FROM tsk_db_info LIMIT 1')[0] ?? {}
    summary.schema_version = info.schema_ver ?? null
    summary.schema_major = Number(ext.get('schemamajorversion') ?? info.schema_ver ?? 0) || null
    summary.schema_minor =
      Number(ext.get('schemaminorversion') ?? info.schema_minor_ver ?? 0) || null
    const tskRaw = ext.get('tskversion') ?? info.tsk_ver ?? null
    summary.tsk_version = tskRaw !== null && /^\d+$/.test(String(tskRaw)) ? Number(tskRaw) : tskRaw

    // metadata do case: existe em alguns schemas, em outros fica fora do DB
    /** @type {Record<string, string>} chave normalizada -> campo do resumo */
    const extMetadataKeys = {
      creationdate: 'creation_date',
      casename: 'case_name',
      casenumber: 'case_number',
      examiner: 'examiner',
    }
    for (const [norm, field] of Object.entries(extMetadataKeys)) {
      const v = ext.get(norm)
      if (v !== undefined) summary[field] = v
    }
    summary.case_metadata_available = [
      'creation_date',
      'case_name',
      'case_number',
      'examiner',
    ].some(k => summary[k] !== undefined)
    if (!summary.case_metadata_available) {
      summary.metadata_note =
        'Este schema não guarda nome/número/data do case no autopsy.db (o Autopsy 4.x mantém isso fora do DB). As versões e os examinadores abaixo vêm do próprio DB.'
    }
    if (tables.has('tsk_examiners')) {
      summary.examiners = h.query('SELECT * FROM tsk_examiners').map(r => ({
        id: r.id,
        login_name: r.login_name,
        display_name: r.display_name,
      }))
    }

    const dsRows = h.query(`
      SELECT dsi.obj_id, dsi.device_id, dsi.time_zone,
             COALESCE(img.name, f.name) AS source_name
      FROM data_source_info dsi
      LEFT JOIN (SELECT obj_id, MIN(name) AS name FROM tsk_image_names GROUP BY obj_id) img
        ON img.obj_id = dsi.obj_id
      LEFT JOIN tsk_files f ON f.obj_id = dsi.obj_id
    `)
    const dataSources = dsRows.map(ds => {
      const cnt = h.query('SELECT COUNT(*) AS c FROM tsk_files WHERE data_source_obj_id = ?', [
        ds.obj_id,
      ])
      return {
        obj_id: ds.obj_id,
        name: ds.source_name,
        device_id: ds.device_id,
        time_zone: ds.time_zone,
        file_count: cnt.length ? cnt[0].c : null,
      }
    })
    summary.data_sources = dataSources

    summary.total_files = h.query('SELECT COUNT(*) AS c FROM tsk_files')[0].c
    summary.total_artifacts = h.query('SELECT COUNT(*) AS c FROM blackboard_artifacts')[0].c
    summary.artifact_breakdown = h.query(`
      SELECT t.artifact_type_id, t.type_name, t.display_name, COUNT(*) AS count
      FROM blackboard_artifacts a
      JOIN blackboard_artifact_types t ON t.artifact_type_id = a.artifact_type_id
      GROUP BY t.artifact_type_id, t.type_name, t.display_name
      ORDER BY count DESC LIMIT 25
    `)
    return ok(summary)
  } finally {
    h.close()
  }
}

/**
 * Navega a árvore tsk_files. Sem args lista as raízes (data sources).
 * @param {Ctx} ctx
 * @param {{ parentPath?: string | null, parentObjId?: number | null,
 *           dataSourceObjId?: number | null, limit?: number, offset?: number }} args
 */
export function browseFilesystem(ctx, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 100), 500))
  const offset = Math.max(0, Number(args.offset ?? 0))
  const h = connectCase(ctx)
  try {
    if (args.parentObjId === null || args.parentObjId === undefined) {
      if (!args.parentPath) {
        /** @type {any[]} */
        const roots = []
        const dsRows = h.query(`
          SELECT dsi.obj_id, COALESCE(img.name, f.name) AS name
          FROM data_source_info dsi
          LEFT JOIN (SELECT obj_id, MIN(name) AS name FROM tsk_image_names GROUP BY obj_id) img
            ON img.obj_id = dsi.obj_id
          LEFT JOIN tsk_files f ON f.obj_id = dsi.obj_id
        `)
        for (const r of dsRows) {
          roots.push({ obj_id: r.obj_id, name: r.name ?? null, kind: 'data source' })
        }
        // atalho: listar os filesystems direto, para não ter que descer por
        // volume system -> volume -> filesystem antes de ver arquivos
        if (h.hasTable('tsk_fs_info')) {
          const fsCols = h.columns('tsk_fs_info')
          const sel = [
            'fsi.obj_id',
            fsCols.includes('fs_type') ? 'fsi.fs_type' : 'NULL AS fs_type',
            fsCols.includes('img_offset') ? 'fsi.img_offset' : 'NULL AS img_offset',
            fsCols.includes('block_size') ? 'fsi.block_size' : 'NULL AS block_size',
          ].join(', ')
          for (const r of h.query(`SELECT ${sel} FROM tsk_fs_info fsi`)) {
            roots.push({
              obj_id: r.obj_id,
              name: null,
              kind: 'filesystem',
              fs_type: r.fs_type,
              img_offset: r.img_offset,
              block_size: r.block_size,
            })
          }
        }
        return ok({
          listing_of: '(roots: data sources + filesystems)',
          entries: roots,
          hint: 'Desça com parent_obj_id. Entradas "filesystem" pulam os nós de volume (útil em imagens com partições). Nós sem nome (data source/volume) também aceitam descida.',
        })
      }
      const pp = args.parentPath.endsWith('/') ? args.parentPath : `${args.parentPath}/`
      const rows = h.query(
        `SELECT f.obj_id, f.name, f.meta_type, f.type, f.size, f.mtime, f.parent_path, f.extension
         FROM tsk_files f WHERE f.parent_path = ?
         ORDER BY f.meta_type DESC, f.name LIMIT ? OFFSET ?`,
        [pp, limit, offset]
      )
      return ok({
        listing_of: args.parentPath,
        count: rows.length,
        offset,
        entries: rows.map(fmtEntry),
        hint: 'Para diretórios use o obj_id como parent_obj_id; para arquivos use get_file_metadata(obj_id).',
      })
    }
    const objTypeSel = h.columns('tsk_objects').includes('type')
      ? 'o.type AS object_type'
      : 'NULL AS object_type'
    const rows = h.query(
      `SELECT o.obj_id, ${objTypeSel}, f.name, f.meta_type, f.type, f.size,
              f.mtime, f.parent_path, f.extension
       FROM tsk_objects o
       LEFT JOIN tsk_files f ON f.obj_id = o.obj_id
       WHERE o.par_obj_id = ?
         AND (? IS NULL OR f.data_source_obj_id = ? OR f.obj_id IS NULL)
       ORDER BY f.meta_type DESC, f.name LIMIT ? OFFSET ?`,
      [args.parentObjId, args.dataSourceObjId ?? null, args.dataSourceObjId ?? null, limit, offset]
    )
    return ok({
      listing_of: `obj_id=${args.parentObjId}`,
      count: rows.length,
      offset,
      entries: rows.map(r => ({
        ...fmtEntry(r),
        // nós intermediários (data source/volume/fs) não têm linha em tsk_files
        name: r.name ?? null,
        kind:
          r.meta_type === null || r.meta_type === undefined
            ? (OBJECT_TYPES[r.object_type] ?? `node(type ${r.object_type})`)
            : dec(META_TYPES, r.meta_type),
        object_type: r.object_type,
      })),
      hint: 'Entradas sem nome são nós intermediários (data source/volume/filesystem) — desça usando o obj_id delas. Para arquivos use get_file_metadata(obj_id).',
    })
  } finally {
    h.close()
  }
}

/** @param {Record<string, any>} r */
function fmtEntry(r) {
  return {
    obj_id: r.obj_id,
    name: r.name,
    kind: dec(META_TYPES, r.meta_type),
    size_bytes: r.size,
    modified: ts(r.mtime),
    extension: r.extension,
    parent_path: r.parent_path,
  }
}

/**
 * Consulta o Blackboard do Autopsy (web history, email, EXIF, chat...).
 * Sem artifact_type lista os tipos presentes com contagens.
 * @param {Ctx} ctx
 * @param {{ artifactType?: string | null, dataSourceObjId?: number | null,
 *           limit?: number, offset?: number }} args
 */
export function queryBlackboardArtifacts(ctx, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 25), 200))
  const offset = Math.max(0, Number(args.offset ?? 0))
  const h = connectCase(ctx)
  try {
    if (!args.artifactType) {
      const types = h.query(`
        SELECT t.artifact_type_id, t.type_name, t.display_name, COUNT(a.artifact_id) AS count
        FROM blackboard_artifact_types t
        JOIN blackboard_artifacts a ON a.artifact_type_id = t.artifact_type_id
        GROUP BY t.artifact_type_id, t.type_name, t.display_name
        ORDER BY count DESC
      `)
      return ok({
        available_artifact_types: types,
        hint: 'Chame esta tool de novo com artifact_type = type_name ou artifact_type_id.',
      })
    }

    const at = String(args.artifactType).trim()
    const trow = /^\d+$/.test(at)
      ? h.query('SELECT * FROM blackboard_artifact_types WHERE artifact_type_id = ?', [Number(at)])
      : h.query(
          'SELECT * FROM blackboard_artifact_types WHERE UPPER(type_name) = UPPER(?) OR UPPER(display_name) = UPPER(?)',
          [at, at]
        )
    if (!trow.length) {
      const known = h.query(
        'SELECT type_name, artifact_type_id FROM blackboard_artifact_types ORDER BY artifact_type_id'
      )
      const names = known.map(k => `${k.type_name}(${k.artifact_type_id})`).join(', ')
      throw new DbError(
        `Tipo de artifact '${args.artifactType}' não encontrado. Tipos disponíveis: ${names}`
      )
    }
    const typeId = trow[0].artifact_type_id
    let where = 'a.artifact_type_id = ?'
    /** @type {import('bun:sqlite').SQLQueryBindings[]} */
    const params = [typeId]
    if (args.dataSourceObjId !== null && args.dataSourceObjId !== undefined) {
      where += ' AND a.data_source_obj_id = ?'
      params.push(args.dataSourceObjId)
    }
    const arts = h.query(
      `SELECT a.artifact_id, a.obj_id, a.data_source_obj_id, f.name AS source_file, f.parent_path
       FROM blackboard_artifacts a
       LEFT JOIN tsk_files f ON f.obj_id = a.obj_id
       WHERE ${where} ORDER BY a.artifact_id LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    )
    const results = arts.map(art => {
      const attrs = h.query(
        `SELECT bat.display_name, bat.type_name, b.value_type, b.value_text, b.value_int32,
                b.value_int64, b.value_double, b.value_byte
         FROM blackboard_attributes b
         JOIN blackboard_attribute_types bat ON bat.attribute_type_id = b.attribute_type_id
         WHERE b.artifact_id = ?`,
        [art.artifact_id]
      )
      /** @type {Record<string, any>} */
      const attributes = {}
      for (const a of attrs) attributes[a.display_name || a.type_name] = attrValue(a)
      return {
        artifact_id: art.artifact_id,
        source_file_obj_id: art.obj_id,
        source_file: (art.parent_path || '') + (art.source_file || '') || null,
        attributes,
      }
    })
    return ok({
      artifact_type: {
        id: typeId,
        type_name: trow[0].type_name,
        display_name: trow[0].display_name,
      },
      count: results.length,
      offset,
      artifacts: results,
    })
  } finally {
    h.close()
  }
}

/**
 * Busca textual no case: nomes de arquivo e/ou conteúdo de artifacts.
 * @param {Ctx} ctx
 * @param {{ keyword?: string, scope?: string, limit?: number }} args
 */
export function searchKeywords(ctx, args = {}) {
  const kw = (args.keyword ?? '').trim()
  if (kw.length < 2) throw new DbError('O keyword deve ter pelo menos 2 caracteres.')
  const scope = (args.scope ?? 'both').trim().toLowerCase()
  if (!['filenames', 'artifacts', 'both'].includes(scope)) {
    throw new DbError("Scope inválido: use 'filenames', 'artifacts' ou 'both'.")
  }
  const limit = Math.max(1, Math.min(Number(args.limit ?? 50), 200))
  const like = `%${kw}%`
  const h = connectCase(ctx)
  try {
    /** @type {Record<string, any>} */
    const out = { keyword: kw, scope }
    if (scope === 'filenames' || scope === 'both') {
      const rows = h.query(
        `SELECT obj_id, name, parent_path, size, mtime FROM tsk_files
         WHERE name LIKE ? ORDER BY name LIMIT ?`,
        [like, limit]
      )
      out.filename_matches = rows.map(r => ({
        obj_id: r.obj_id,
        path: (r.parent_path || '') + (r.name || ''),
        size_bytes: r.size,
        modified: ts(r.mtime),
      }))
    }
    if (scope === 'artifacts' || scope === 'both') {
      const rows = h.query(
        `SELECT b.artifact_id, b.value_text, bat.display_name AS attribute,
                t.type_name AS artifact_type, a.obj_id AS source_file_obj_id, f.name AS source_file
         FROM blackboard_attributes b
         JOIN blackboard_artifacts a ON a.artifact_id = b.artifact_id
         JOIN blackboard_artifact_types t ON t.artifact_type_id = a.artifact_type_id
         JOIN blackboard_attribute_types bat ON bat.attribute_type_id = b.attribute_type_id
         LEFT JOIN tsk_files f ON f.obj_id = a.obj_id
         WHERE b.value_text LIKE ? ORDER BY b.artifact_id LIMIT ?`,
        [like, limit]
      )
      out.artifact_matches = rows.map(r => ({
        artifact_id: r.artifact_id,
        artifact_type: r.artifact_type,
        attribute: r.attribute,
        value_excerpt: (r.value_text || '').slice(0, 400),
        source_file: r.source_file,
        source_file_obj_id: r.source_file_obj_id,
      }))
    }
    out.hint =
      'Aprofunde em um arquivo com get_file_metadata(obj_id) ou em um tipo de artifact com query_blackboard_artifacts.'
    return ok(out)
  } finally {
    h.close()
  }
}

/**
 * Metadata forense completa de um arquivo: hashes, MAC times, status known/notable.
 * @param {Ctx} ctx
 * @param {{ objId: number }} args
 */
export function getFileMetadata(ctx, args) {
  const h = connectCase(ctx)
  try {
    const f = getFileRow(h, args.objId)
    if (!f) {
      throw new DbError(
        `Nenhum arquivo com obj_id=${args.objId} em tsk_files. Encontre obj_ids válidos com browse_filesystem ou search_keywords.`
      )
    }
    const arts = h.query(
      `SELECT t.type_name, COUNT(*) AS count
       FROM blackboard_artifacts a
       JOIN blackboard_artifact_types t ON t.artifact_type_id = a.artifact_type_id
       WHERE a.obj_id = ? GROUP BY t.type_name ORDER BY count DESC`,
      [args.objId]
    )
    // conta de SO dona do arquivo (o nome da tabela varia por versão)
    /** @type {Record<string, any> | null} */
    let ownerAccount = null
    if (h.columns('tsk_files').includes('os_account_obj_id') && f.os_account_obj_id) {
      if (h.hasTable('tsk_os_accounts')) {
        const rows = h.query(
          'SELECT os_account_obj_id, login_name, full_name, addr FROM tsk_os_accounts WHERE os_account_obj_id = ?',
          [f.os_account_obj_id]
        )
        if (rows.length) ownerAccount = rows[0]
      } else if (h.hasTable('os_accounts')) {
        const rows = h.query(
          'SELECT os_account_obj_id, identifier, display_name FROM os_accounts WHERE os_account_obj_id = ?',
          [f.os_account_obj_id]
        )
        if (rows.length) ownerAccount = rows[0]
      }
    }
    return ok({
      obj_id: f.obj_id,
      name: f.name,
      full_path: (f.parent_path || '') + (f.name || ''),
      data_source_obj_id: f.data_source_obj_id,
      kind: dec(META_TYPES, f.meta_type),
      size_bytes: f.size,
      extension: f.extension,
      mime_type: f.mime_type,
      hashes: { md5: f.md5, sha256: f.sha256, sha1: f.sha1 },
      known_status: dec(KNOWN_STATUS, f.known),
      mac_times: {
        'modified (mtime)': ts(f.mtime),
        'accessed (atime)': ts(f.atime),
        'changed (ctime)': ts(f.ctime),
        'created (crtime)': ts(f.crtime),
      },
      owner_uid: f.uid,
      owner_gid: f.gid,
      owner_account: ownerAccount,
      meta_addr: f.meta_addr,
      associated_artifacts: arts,
    })
  } finally {
    h.close()
  }
}

/**
 * Lista as tags do case com contagens por tipo (arquivos/artifacts/conteúdo).
 * @param {Ctx} ctx
 * @param {object} _args
 */
export function browseTags(ctx, _args = {}) {
  const h = connectCase(ctx)
  try {
    const tagCols = h.columns('tag_names')
    if (!tagCols.length) throw new DbError('Este case não tem a tabela tag_names.')
    const knownCol = tagCols.includes('known_status')
      ? 'known_status'
      : tagCols.includes('knownStatus')
        ? 'knownStatus'
        : null
    // o nome das tabelas de tag varia conforme a versão do Autopsy
    const fileTagTable = h.hasTable('file_tags')
      ? 'file_tags'
      : h.hasTable('content_tags')
        ? 'content_tags'
        : null
    const artTagTable = h.hasTable('artifact_tags')
      ? 'artifact_tags'
      : h.hasTable('blackboard_artifact_tags')
        ? 'blackboard_artifact_tags'
        : null

    const knownSel = knownCol ? `, ${knownCol} AS known_status` : ', NULL AS known_status'
    const tags = h.query(
      `SELECT tag_name_id, display_name, description, color${knownSel} FROM tag_names ORDER BY tag_name_id`
    )
    /** @param {string | null} table @param {number} tagId */
    const countFor = (table, tagId) =>
      table
        ? h.query(`SELECT COUNT(*) AS c FROM ${table} WHERE tag_name_id = ?`, [tagId])[0].c
        : null
    const result = tags.map(t => {
      const fileCount = countFor(fileTagTable, t.tag_name_id)
      const artCount = countFor(artTagTable, t.tag_name_id)
      let contentCount = null
      if (
        fileTagTable === 'content_tags' &&
        h.columns('content_tags').includes('begin_byte_offset')
      ) {
        contentCount = h.query(
          'SELECT COUNT(*) AS c FROM content_tags WHERE tag_name_id = ? AND (begin_byte_offset IS NOT NULL OR end_byte_offset IS NOT NULL)',
          [t.tag_name_id]
        )[0].c
      }
      return {
        tag_name_id: t.tag_name_id,
        display_name: t.display_name,
        description: t.description,
        color: t.color,
        known_status: dec(KNOWN_STATUS, t.known_status),
        file_count: fileCount,
        artifact_count: artCount,
        content_count: contentCount,
        file_tag_table: fileTagTable,
      }
    })
    return ok({ count: result.length, tags: result })
  } finally {
    h.close()
  }
}

/**
 * Linha do tempo do filesystem: eventos de tsk_files numa janela de MAC times.
 * @param {Ctx} ctx
 * @param {{ start?: number | null, end?: number | null, field?: string,
 *           order?: string, limit?: number, offset?: number }} args
 */
export function browseTimeline(ctx, args = {}) {
  const fields = ['mtime', 'atime', 'ctime', 'crtime']
  const field = typeof args.field === 'string' && fields.includes(args.field) ? args.field : 'mtime'
  const start = args.start !== null && args.start !== undefined ? Number(args.start) : 0
  const end =
    args.end !== null && args.end !== undefined ? Number(args.end) : Math.floor(Date.now() / 1000)
  const limit = Math.max(1, Math.min(Number(args.limit ?? 100), 500))
  const offset = Math.max(0, Number(args.offset ?? 0))
  // desc evita OFFSET profundo quando o interesse é o fim da janela
  const order = args.order === 'desc' ? 'DESC' : 'ASC'
  const h = connectCase(ctx)
  try {
    // Preferir a tabela de eventos do Autopsy (timeline real, com tipo/descrição)
    if (h.hasTable('tsk_events')) {
      const typeCols = h.columns('tsk_event_types')
      const descCols = h.columns('tsk_event_descriptions')
      const typeCol = typeCols.includes('display_name')
        ? 'display_name'
        : typeCols.includes('type_name')
          ? 'type_name'
          : null
      const descCol = descCols.includes('full_description')
        ? 'full_description'
        : descCols.includes('description')
          ? 'description'
          : null
      const join =
        (typeCol ? ' LEFT JOIN tsk_event_types t ON t.event_type_id = e.event_type_id' : '') +
        (descCol
          ? ' LEFT JOIN tsk_event_descriptions d ON d.event_description_id = e.event_description_id'
          : '')
      const sel = [
        'e.event_id',
        'e.event_type_id',
        'e.event_description_id',
        'e.time',
        typeCol ? `t.${typeCol} AS event_type` : null,
        descCol ? `d.${descCol} AS event_description` : null,
        descCols.includes('content_obj_id') ? 'd.content_obj_id' : null,
      ]
        .filter(Boolean)
        .join(', ')
      const rows = h.query(
        `SELECT ${sel} FROM tsk_events e${join} WHERE e.time >= ? AND e.time <= ? ORDER BY e.time ${order} LIMIT ? OFFSET ?`,
        [start, end, limit, offset]
      )
      const total = h.query('SELECT COUNT(*) AS c FROM tsk_events WHERE time >= ? AND time <= ?', [
        start,
        end,
      ])[0].c
      return ok({
        source: 'tsk_events',
        start,
        end,
        order: order.toLowerCase(),
        count: rows.length,
        total_in_window: total,
        offset,
        events: rows.map(r => ({
          event_id: r.event_id,
          time: r.time,
          time_utc: ts(r.time),
          type: r.event_type ?? r.event_type_id,
          description: r.event_description ?? r.event_description_id,
          content_obj_id: r.content_obj_id ?? null,
        })),
      })
    }
    const rows = h.query(
      `SELECT obj_id, name, parent_path, size, mtime, atime, ctime, crtime
       FROM tsk_files WHERE ${field} >= ? AND ${field} <= ?
       ORDER BY ${field} ${order} LIMIT ? OFFSET ?`,
      [start, end, limit, offset]
    )
    return ok({
      source: 'tsk_files',
      field,
      start,
      end,
      order: order.toLowerCase(),
      count: rows.length,
      offset,
      hint: 'Este case não tem tsk_events: a timeline é derivada dos MAC times de tsk_files.',
      events: rows.map(r => ({
        obj_id: r.obj_id,
        path: (r.parent_path || '') + (r.name || ''),
        time: r[field],
        time_utc: ts(r[field]),
        size_bytes: r.size,
      })),
    })
  } finally {
    h.close()
  }
}
/**
 * Contas de SO detectadas no case (Autopsy 4.19+).
 * @param {Ctx} ctx
 * @param {object} _args
 */
export function getOsAccounts(ctx, _args = {}) {
  const h = connectCase(ctx)
  try {
    // schema moderno/simplificado
    if (h.hasTable('os_accounts')) {
      const rows = h.query('SELECT * FROM os_accounts ORDER BY os_account_obj_id')
      return ok({
        model: 'os_accounts',
        count: rows.length,
        accounts: rows.map(r => ({
          os_account_obj_id: r.os_account_obj_id,
          data_source_obj_id: r.data_source_obj_id,
          identifier: r.identifier,
          display_name: r.display_name,
          realm_scope: r.realm_scope,
          login_name: r.login_name,
          domain: r.domain,
          account_status: r.account_status,
          created: ts(r.creation_date),
          deleted: ts(r.deletion_date),
        })),
      })
    }
    // schema legacy/normalizado (Autopsy 4.x — tsk_os_accounts)
    if (h.hasTable('tsk_os_accounts')) {
      /** @type {Map<number, string>} */
      const realmById = new Map()
      if (h.hasTable('tsk_os_account_realms')) {
        for (const r of h.query('SELECT id, realm_name FROM tsk_os_account_realms')) {
          realmById.set(r.id, r.realm_name)
        }
      }
      /** @type {Map<number, number[]>} */
      const dsByAccount = new Map()
      if (h.hasTable('tsk_os_account_instances')) {
        for (const i of h.query(
          'SELECT os_account_obj_id, data_source_obj_id FROM tsk_os_account_instances'
        )) {
          const list = dsByAccount.get(i.os_account_obj_id) ?? []
          list.push(i.data_source_obj_id)
          dsByAccount.set(i.os_account_obj_id, list)
        }
      }
      const rows = h.query('SELECT * FROM tsk_os_accounts ORDER BY os_account_obj_id')
      /** @type {Map<number, number>} */
      const fileCounts = new Map()
      if (h.columns('tsk_files').includes('os_account_obj_id')) {
        for (const r of h.query(
          'SELECT os_account_obj_id, COUNT(*) AS c FROM tsk_files WHERE os_account_obj_id IS NOT NULL GROUP BY os_account_obj_id'
        )) {
          fileCounts.set(r.os_account_obj_id, r.c)
        }
      }
      return ok({
        model: 'tsk_os_accounts',
        count: rows.length,
        accounts: rows.map(r => ({
          os_account_obj_id: r.os_account_obj_id,
          login_name: r.login_name,
          full_name: r.full_name,
          // muitas contas locais vêm só com SID: usa como rótulo legível
          label: r.login_name ?? r.full_name ?? r.addr ?? `account ${r.os_account_obj_id}`,
          sid: r.addr,
          realm: realmById.get(r.realm_id) ?? null,
          status: r.status,
          created: ts(r.created_date),
          data_sources: dsByAccount.get(r.os_account_obj_id) ?? [],
          file_count: fileCounts.get(r.os_account_obj_id) ?? 0,
        })),
      })
    }
    throw new DbError('Este case não tem tabela de contas de SO (os_accounts nem tsk_os_accounts).')
  } finally {
    h.close()
  }
}

/**
 * Hits do índice de keywords do Autopsy (com excerpt).
 * @param {Ctx} ctx
 * @param {{ keyword?: string | null, limit?: number }} args
 */
export function searchKeywordHits(ctx, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 50), 200))
  const kw = (args.keyword ?? '').trim()
  const h = connectCase(ctx)
  try {
    if (!h.hasTable('keyword_hits')) {
      return ok({
        available: false,
        reason:
          'Este schema não guarda os hits de keyword no SQLite: o índice de texto do Autopsy fica em Lucene, no diretório index/ do case.',
        hint: 'Use search_keywords (busca em nomes de arquivo e atributos do DB) — hits de conteúdo indexado não são acessíveis por SQL.',
      })
    }
    let rows
    if (kw.length >= 2) {
      rows = h.query(`SELECT * FROM keyword_hits WHERE excerpt LIKE ? ORDER BY id LIMIT ?`, [
        `%${kw}%`,
        limit,
      ])
    } else {
      rows = h.query('SELECT * FROM keyword_hits ORDER BY id LIMIT ?', [limit])
    }
    const files = h.listTables().includes('tsk_files')
    return ok({
      keyword: kw || null,
      count: rows.length,
      hits: rows.map(r => ({
        hit_id: r.id,
        keyword_search_run_id: r.keyword_search_run_id,
        file_obj_id: r.obj_id ?? r.file_id ?? null,
        artifact_id: r.artifact_id ?? null,
        offset: r.offset,
        source: r.source,
        excerpt: r.excerpt,
        file_name: files ? (getFileRow(h, r.obj_id ?? r.file_id)?.name ?? null) : null,
      })),
    })
  } finally {
    h.close()
  }
}

/**
 * Hex dump de um slice do arquivo (via export dir ou mount root).
 * @param {Ctx} ctx
 * @param {{ objId: number, path?: string, offset?: number, length?: number }} args
 */
export function getFileHex(ctx, args) {
  const { h, file } = withContent(ctx, args.objId, args.path)
  try {
    const offset = Math.max(0, Number(args.offset ?? 0))
    const length = Math.max(1, Math.min(Number(args.length ?? 64), 4096))
    const buf = Buffer.from(readSlice(file.path, offset, length))
    return ok({
      obj_id: args.objId,
      matched_by: file.source,
      content_verified: file.verified,
      path: file.path,
      offset,
      length: buf.length,
      hex: [...buf].map(b => b.toString(16).padStart(2, '0')).join(' '),
      ascii: [...buf].map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join(''),
    })
  } finally {
    h.close()
  }
}

/**
 * Strings ASCII/UTF-8 do arquivo (via export dir ou mount root).
 * @param {Ctx} ctx
 * @param {{ objId: number, path?: string, minLength?: number, limit?: number }} args
 */
export function getFileStrings(ctx, args) {
  const { h, file } = withContent(ctx, args.objId, args.path)
  try {
    const minLength = Math.max(3, Math.min(Number(args.minLength ?? 5), 64))
    const limit = Math.max(1, Math.min(Number(args.limit ?? 200), 500))
    const buf = readAll(file.path)
    return ok({
      obj_id: args.objId,
      matched_by: file.source,
      content_verified: file.verified,
      path: file.path,
      strings: extractStrings(buf, minLength, limit),
    })
  } finally {
    h.close()
  }
}

/**
 * Copia o arquivo para outPath (fora do case — nunca escreve dentro do case).
 * @param {Ctx} ctx
 * @param {{ objId: number, path?: string, outPath: string }} args
 */
export function extractFile(ctx, args) {
  const { h, file } = withContent(ctx, args.objId, args.path)
  try {
    const outPath = resolve(args.outPath ?? '')
    if (!outPath) throw new DbError('Passe outPath (caminho absoluto de destino).')
    if (ctx.active.caseDir && isInside(ctx.active.caseDir, outPath)) {
      throw new DbError(
        'outPath está dentro da pasta do case — recusado para preservar a cadeia de custódia. Escolha um destino fora do case.'
      )
    }
    const written = copyTo(file.path, outPath)
    return ok({
      status: 'ok',
      obj_id: args.objId,
      matched_by: file.source,
      content_verified: file.verified,
      out_path: outPath,
      written_bytes: written,
    })
  } finally {
    h.close()
  }
}

/**
 * Helper: resolve conteúdo + mantém conexão aberta até o caller fechar.
 * `explicitPath` (opcional) desempata arquivos homônimos quando o DB não tem hash.
 * @param {Ctx} ctx
 * @param {number} objId
 * @param {string} [explicitPath]
 */
function withContent(ctx, objId, explicitPath) {
  const h = connectCase(ctx)
  const f = getFileRow(h, objId)
  if (!f) {
    h.close()
    throw new DbError(
      `Nenhum arquivo com obj_id=${objId} em tsk_files. Use browse_filesystem ou search_keywords para encontrar obj_ids.`
    )
  }
  if (explicitPath) {
    try {
      return { h, file: resolveExplicitPath(ctx, explicitPath) }
    } catch (e) {
      h.close()
      throw e
    }
  }
  const file = resolveContentPath(ctx, f)
  if (file && 'ambiguous' in file) {
    h.close()
    throw new DbError(
      `Conteúdo ambíguo: ${file.candidates.length} arquivos no Export com o mesmo nome e tamanho (${f.name}), e o DB não tem sha256 para desempatar. Candidatos: ${file.candidates.join(' | ')}`
    )
  }
  if (!file) {
    h.close()
    throw new DbError(
      `Conteúdo do arquivo não disponível: exporte o arquivo pelo Autopsy (cria <case>/Export, casado por nome+tamanho e confirmado por sha256), configure AUTOPSY_EXPORT_DIR, ou monte a imagem read-only em AUTOPSY_FILES_ROOT. O arquivo tem sha256=${f.sha256 ?? 'n/d'}.`
    )
  }
  return { h, file }
}

// ---------------------------------------------------------------------------
// Camada de análise: busca por tipo/hash, conversas, SQLite de app, extrato
// ---------------------------------------------------------------------------

/**
 * Classifica um atributo de artefato num campo normalizado de mensagem.
 * @param {string} label
 * @returns {string | null}
 */
function classifyAttr(label) {
  const L = label.toUpperCase()
  if (/DIRECTION/.test(L)) return 'direction'
  if (/TYPE/.test(L)) return 'type'
  if (/DATETIME|DATE|TIME/.test(L)) return 'time'
  if (/PHONE|NUMBER|ADDRESS|PARTICIPANT|CONTACT|FROM/.test(L)) return 'participant'
  if (/TEXT|BODY|MESSAGE|SUBJECT|DESCRIPTION|EXCERPT|URL|QUERY/.test(L)) return 'body'
  return null
}

/**
 * Resolve o id de um tipo de artefato por id numérico, type_name ou display_name.
 * @param {{ query: Function }} h
 * @param {string | number} spec
 */
function resolveArtifactType(h, spec) {
  const raw = String(spec).trim()
  const rows = /^\d+$/.test(raw)
    ? h.query('SELECT * FROM blackboard_artifact_types WHERE artifact_type_id = ?', [Number(raw)])
    : h.query(
        'SELECT * FROM blackboard_artifact_types WHERE UPPER(type_name) = UPPER(?) OR UPPER(display_name) = UPPER(?)',
        [raw, raw]
      )
  if (!rows.length) {
    const known = h.query(
      'SELECT type_name, artifact_type_id FROM blackboard_artifact_types ORDER BY artifact_type_id'
    )
    throw new DbError(
      `Tipo de artifact '${spec}' não encontrado. Disponíveis: ${known.map(/** @param {any} k */ k => `${k.type_name}(${k.artifact_type_id})`).join(', ')}`
    )
  }
  return rows[0]
}

/**
 * Busca arquivos por tipo MIME, extensão, hash, status known/notable, tamanho,
 * caminho e janela de tempo. Sem filtro, ordena por tamanho decrescente.
 * @param {Ctx} ctx
 * @param {{ name?: string, mimeType?: string, extension?: string, sha256?: string,
 *           md5?: string, sha1?: string, known?: number, sizeMin?: number, sizeMax?: number,
 *           pathContains?: string, after?: number, before?: number,
 *           limit?: number, offset?: number }} args
 */
export function findFiles(ctx, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 100), 1000))
  const offset = Math.max(0, Number(args.offset ?? 0))
  const h = connectCase(ctx)
  try {
    /** @type {string[]} */
    const where = []
    /** @type {import('bun:sqlite').SQLQueryBindings[]} */
    const params = []
    if (args.name) {
      where.push('name LIKE ?')
      params.push(`%${args.name}%`)
    }
    if (args.mimeType) {
      where.push('mime_type LIKE ?')
      params.push(String(args.mimeType).includes('%') ? args.mimeType : `%${args.mimeType}%`)
    }
    if (args.extension) {
      where.push('LOWER(extension) = LOWER(?)')
      params.push(String(args.extension).replace(/^\./, ''))
    }
    for (const key of ['sha256', 'md5', 'sha1']) {
      const v = args[/** @type {'sha256'|'md5'|'sha1'} */ (key)]
      if (v) {
        // hashes são case-insensitive; o OR mantém o caminho rápido (índice)
        // quando o valor já vem em minúsculas, como o Autopsy grava
        where.push(`(${key} = ? OR LOWER(${key}) = ?)`)
        params.push(String(v).toLowerCase(), String(v).toLowerCase())
      }
    }
    if (args.known !== undefined && args.known !== null) {
      where.push('known = ?')
      params.push(Number(args.known))
    }
    if (args.sizeMin !== undefined && args.sizeMin !== null) {
      where.push('size >= ?')
      params.push(Number(args.sizeMin))
    }
    if (args.sizeMax !== undefined && args.sizeMax !== null) {
      where.push('size <= ?')
      params.push(Number(args.sizeMax))
    }
    if (args.pathContains) {
      where.push("(COALESCE(parent_path,'') || COALESCE(name,'')) LIKE ?")
      params.push(`%${args.pathContains}%`)
    }
    if (args.after) {
      where.push('COALESCE(mtime, crtime) >= ?')
      params.push(Number(args.after))
    }
    if (args.before) {
      where.push('COALESCE(mtime, crtime) <= ?')
      params.push(Number(args.before))
    }
    const sql = `
      SELECT obj_id, name, parent_path, extension, mime_type, size, known,
             md5, sha256, sha1, mtime, atime, ctime, crtime
      FROM tsk_files
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY size DESC LIMIT ? OFFSET ?`
    const rows = h.query(sql, [...params, limit, offset])
    return ok({
      filters: args,
      count: rows.length,
      offset,
      files: rows.map(f => ({
        obj_id: f.obj_id,
        path: (f.parent_path || '') + (f.name || ''),
        name: f.name,
        extension: f.extension,
        mime_type: f.mime_type,
        size_bytes: f.size,
        known_status: dec(KNOWN_STATUS, f.known),
        hashes: { md5: f.md5, sha256: f.sha256, sha1: f.sha1 },
        modified: ts(f.mtime),
      })),
      hint: 'Use o obj_id com get_file_metadata, open_sqlite (se for SQLite) ou get_file_hex/get_file_strings.',
    })
  } finally {
    h.close()
  }
}

/**
 * Busca um termo em TODOS os atributos de artefatos (mensagens, buscas, URLs,
 * contatos...) e devolve os artefatos com todos os seus atributos.
 * @param {Ctx} ctx
 * @param {{ term?: string, artifactType?: string, attributeName?: string,
 *           limit?: number, offset?: number }} args
 */
export function findArtifacts(ctx, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 50), 500))
  const offset = Math.max(0, Number(args.offset ?? 0))
  if (!args.term && !args.artifactType && !args.attributeName) {
    throw new DbError('Passe ao menos um filtro: term, artifactType ou attributeName.')
  }
  const h = connectCase(ctx)
  try {
    /** @type {string[]} */
    const where = []
    /** @type {import('bun:sqlite').SQLQueryBindings[]} */
    const params = []
    if (args.term) {
      where.push('(b.value_text LIKE ? OR b.value_int64 LIKE ?)')
      params.push(`%${args.term}%`, `%${args.term}%`)
    }
    if (args.artifactType) {
      where.push('a.artifact_type_id = ?')
      params.push(resolveArtifactType(h, args.artifactType).artifact_type_id)
    }
    if (args.attributeName) {
      where.push('(UPPER(bat.display_name) LIKE UPPER(?) OR UPPER(bat.type_name) LIKE UPPER(?))')
      params.push(`%${args.attributeName}%`, `%${args.attributeName}%`)
    }
    const hits = h.query(
      `SELECT DISTINCT a.artifact_id
       FROM blackboard_artifacts a
       JOIN blackboard_attributes b ON b.artifact_id = a.artifact_id
       LEFT JOIN blackboard_attribute_types bat ON bat.attribute_type_id = b.attribute_type_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.artifact_id LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    )
    const artifacts = hits.map(hit => {
      const info = h.query(
        `SELECT a.artifact_id, a.obj_id, t.type_name AS artifact_type, f.parent_path, f.name AS source_file
         FROM blackboard_artifacts a
         JOIN blackboard_artifact_types t ON t.artifact_type_id = a.artifact_type_id
         LEFT JOIN tsk_files f ON f.obj_id = a.obj_id
         WHERE a.artifact_id = ?`,
        [hit.artifact_id]
      )[0]
      const attrs = h.query(
        `SELECT bat.display_name, bat.type_name, b.value_type, b.value_text, b.value_int32,
                b.value_int64, b.value_double, b.value_byte
         FROM blackboard_attributes b
         LEFT JOIN blackboard_attribute_types bat ON bat.attribute_type_id = b.attribute_type_id
         WHERE b.artifact_id = ?`,
        [hit.artifact_id]
      )
      /** @type {Record<string, any>} */
      const attributes = {}
      let matched = null
      for (const a of attrs) {
        const label = a.display_name || a.type_name || `attr_${Object.keys(attributes).length}`
        attributes[label] = attrValue(a)
        if (args.term && String(attributes[label]).includes(args.term)) matched = label
      }
      return {
        artifact_id: info.artifact_id,
        artifact_type: info.artifact_type,
        source_file_obj_id: info.obj_id,
        source_file: (info.parent_path || '') + (info.source_file || '') || null,
        matched_attribute: matched,
        attributes,
      }
    })
    return ok({ filters: args, count: artifacts.length, offset, artifacts })
  } finally {
    h.close()
  }
}

/**
 * Agrupa artefatos de mensagem/chat por participante e devolve as conversas
 * ordenadas por tempo (útil para triagem de aliciamento / conversas suspeitas).
 * @param {Ctx} ctx
 * @param {{ participant?: string, from?: number, to?: number, limit?: number }} args
 */
export function extractConversations(ctx, args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 30), 200))
  const h = connectCase(ctx)
  try {
    const types = h.query(
      `SELECT artifact_type_id, type_name FROM blackboard_artifact_types
       WHERE UPPER(type_name) LIKE '%MESSAGE%' OR UPPER(type_name) LIKE '%CHAT%'
          OR UPPER(type_name) LIKE '%SMS%' OR UPPER(type_name) LIKE '%CALL%'`
    )
    if (!types.length) {
      throw new DbError(
        'Este case não tem tipos de artefato de mensagem/chat (rodar ingest mobile no Autopsy). Use find_artifacts para varrer atributos.'
      )
    }
    const ids = types.map(t => t.artifact_type_id)
    const rows = h.query(
      `SELECT a.artifact_id, a.obj_id, t.type_name AS artifact_type,
              bat.type_name AS attr_type, bat.display_name AS attr_name,
              b.value_type, b.value_text, b.value_int64, b.value_double, b.value_byte
       FROM blackboard_artifacts a
       JOIN blackboard_artifact_types t ON t.artifact_type_id = a.artifact_type_id
       LEFT JOIN blackboard_attributes b ON b.artifact_id = a.artifact_id
       LEFT JOIN blackboard_attribute_types bat ON bat.attribute_type_id = b.attribute_type_id
       WHERE a.artifact_type_id IN (${ids.map(() => '?').join(',')})
       ORDER BY a.artifact_id`,
      ids
    )
    /** @type {Map<number, any>} */
    const byArtifact = new Map()
    for (const r of rows) {
      if (!byArtifact.has(r.artifact_id)) {
        byArtifact.set(r.artifact_id, {
          artifact_id: r.artifact_id,
          source_file_obj_id: r.obj_id,
          artifact_type: r.artifact_type,
          attributes: {},
          fields: {},
          time: null,
        })
      }
      if (r.attr_name === null && r.attr_type === null) continue
      const rec = byArtifact.get(r.artifact_id)
      const label = r.attr_name || r.attr_type
      const value = attrValue(r)
      rec.attributes[label] = value
      const kind = classifyAttr(`${r.attr_type ?? ''} ${r.attr_name ?? ''}`)
      if (kind && kind !== 'time' && rec.fields[kind] === undefined && value)
        rec.fields[kind] = value
      if (kind === 'time') {
        // guarda o epoch cru para filtrar/ordenar (attrValue devolve ISO)
        const raw = r.value_type === 5 ? r.value_int64 : Date.parse(String(value)) / 1000
        if (Number.isFinite(raw) && rec.time === null) rec.time = raw
      }
    }
    let messages = [...byArtifact.values()].map(m => ({
      artifact_id: m.artifact_id,
      source_file_obj_id: m.source_file_obj_id,
      artifact_type: m.artifact_type,
      time: m.time,
      time_utc: ts(m.time),
      participant: m.fields.participant ?? null,
      direction: m.fields.direction ?? null,
      type: m.fields.type ?? null,
      body: m.fields.body ?? null,
      attributes: m.attributes,
    }))
    if (args.participant) {
      const needle = String(args.participant).replace(/\D/g, '')
      messages = messages.filter(
        m => m.participant && String(m.participant).replace(/\D/g, '').includes(needle)
      )
    }
    if (args.from) messages = messages.filter(m => m.time !== null && m.time >= Number(args.from))
    if (args.to) messages = messages.filter(m => m.time !== null && m.time <= Number(args.to))

    /** @type {Map<string, any>} */
    const threads = new Map()
    for (const m of messages) {
      const key = m.participant ?? '(sem participante)'
      if (!threads.has(key)) threads.set(key, { participant: key, messages: [] })
      threads.get(key).messages.push(m)
    }
    const conversations = [...threads.values()]
      .map(t => {
        t.messages.sort(
          (/** @type {any} */ a, /** @type {any} */ b) => (a.time ?? 0) - (b.time ?? 0)
        )
        return {
          participant: t.participant,
          message_count: t.messages.length,
          first_utc: ts(t.messages[0]?.time),
          last_utc: ts(t.messages[t.messages.length - 1]?.time),
          messages: t.messages,
        }
      })
      .sort((a, b) => b.message_count - a.message_count)
      .slice(0, limit)
    return ok({
      message_artifact_types: types.map(t => t.type_name),
      total_messages: messages.length,
      conversation_count: conversations.length,
      conversations,
    })
  } finally {
    h.close()
  }
}

/**
 * Abre um SQLite de dentro da imagem (msgstore.db do WhatsApp, History do
 * Chromium, ChatStorage.sqlite do iOS...) e roda um SELECT read-only.
 * @param {Ctx} ctx
 * @param {{ objId: number, path?: string, sql: string, params?: Array<string|number>, limit?: number }} args
 */
export function openSqlite(ctx, args) {
  const sqlText = String(args.sql ?? '')
    .trim()
    .replace(/;+\s*$/, '')
  const isPragma = /^pragma\s+(table_info|table_list|database_list|index_list)\b/i.test(sqlText)
  if (!isPragma && !/^(select|with)\b/i.test(sqlText)) {
    throw new DbError(
      'Somente SELECT/WITH/PRAGMA table_info são aceitos nesta tool (read-only por design).'
    )
  }
  const limit = Math.max(1, Math.min(Number(args.limit ?? 100), 1000))
  const bind = Array.isArray(args.params) ? args.params : []
  const { h, file } = withContent(ctx, args.objId, args.path)
  try {
    const db = openSqliteReadonly(file.path)
    try {
      const rows = isPragma
        ? db.query(sqlText).all(...bind)
        : db.query(`SELECT * FROM (${sqlText}) LIMIT ?`).all(...bind, limit + 1)
      const truncated = rows.length > limit
      return ok({
        obj_id: args.objId,
        matched_by: file.source,
        content_verified: file.verified,
        path: file.path,
        row_count: Math.min(rows.length, limit),
        truncated,
        rows: rows.slice(0, limit),
      })
    } finally {
      db.close()
    }
  } finally {
    h.close()
  }
}

/**
 * Gera um extrato citável (JSON) com metadados, hashes e artefatos dos itens
 * selecionados, para anexar ao laudo. Nunca escreve dentro do case.
 * @param {Ctx} ctx
 * @param {{ objIds?: number[], artifactIds?: number[], outPath: string }} args
 */
export function exportEvidence(ctx, args) {
  const outPath = resolve(args.outPath ?? '')
  if (!outPath) throw new DbError('Passe outPath (caminho absoluto de destino, fora do case).')
  if (ctx.active.caseDir && isInside(ctx.active.caseDir, outPath)) {
    throw new DbError(
      'outPath está dentro da pasta do case — recusado para preservar a cadeia de custódia.'
    )
  }
  const objIds = Array.isArray(args.objIds) ? args.objIds : []
  const artifactIds = Array.isArray(args.artifactIds) ? args.artifactIds : []
  if (!objIds.length && !artifactIds.length) throw new DbError('Passe objIds e/ou artifactIds.')

  const h = connectCase(ctx)
  try {
    const files = objIds.map(id => {
      const f = getFileRow(h, id)
      if (!f) throw new DbError(`obj_id ${id} não encontrado em tsk_files.`)
      const arts = h.query(
        `SELECT a.artifact_id, t.type_name FROM blackboard_artifacts a
         JOIN blackboard_artifact_types t ON t.artifact_type_id = a.artifact_type_id
         WHERE a.obj_id = ?`,
        [id]
      )
      return {
        obj_id: f.obj_id,
        path: (f.parent_path || '') + (f.name || ''),
        size_bytes: f.size,
        mime_type: f.mime_type,
        hashes: { md5: f.md5, sha256: f.sha256, sha1: f.sha1 },
        known_status: dec(KNOWN_STATUS, f.known),
        mac_times: {
          modified: ts(f.mtime),
          accessed: ts(f.atime),
          changed: ts(f.ctime),
          created: ts(f.crtime),
        },
        artifacts: arts,
      }
    })
    const artifacts = artifactIds.map(id => {
      const info = h.query(
        `SELECT a.artifact_id, a.obj_id, t.type_name FROM blackboard_artifacts a
         JOIN blackboard_artifact_types t ON t.artifact_type_id = a.artifact_type_id
         WHERE a.artifact_id = ?`,
        [id]
      )[0]
      if (!info) throw new DbError(`artifact_id ${id} não encontrado.`)
      const attrs = h.query(
        `SELECT bat.display_name, bat.type_name, b.value_type, b.value_text,
                b.value_int64, b.value_double, b.value_byte
         FROM blackboard_attributes b
         LEFT JOIN blackboard_attribute_types bat ON bat.attribute_type_id = b.attribute_type_id
         WHERE b.artifact_id = ?`,
        [id]
      )
      /** @type {Record<string, any>} */
      const attributes = {}
      for (const a of attrs) attributes[a.display_name || a.type_name] = attrValue(a)
      return {
        artifact_id: info.artifact_id,
        artifact_type: info.type_name,
        source_file_obj_id: info.obj_id,
        attributes,
      }
    })
    const payload = {
      generated_by: 'coroner (read-only)',
      generated_at: new Date().toISOString(),
      case: ctx.active.label,
      case_db: ctx.active.dbPath,
      file_count: files.length,
      artifact_count: artifacts.length,
      files,
      artifacts,
    }
    const json = JSON.stringify(payload, null, 2)
    writeFileSync(outPath, json)
    return ok({
      status: 'ok',
      out_path: outPath,
      file_count: files.length,
      artifact_count: artifacts.length,
      written_bytes: Buffer.byteLength(json),
    })
  } finally {
    h.close()
  }
}

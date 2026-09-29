/**
 * Mapas de decodificação do schema TSK/Autopsy + helpers de formatação.
 */

/** @type {Record<number, string>} */
export const META_TYPES = {
  0: 'undefined',
  1: 'file',
  2: 'directory',
  3: 'named pipe',
  4: 'character device',
  5: 'block device',
  6: 'symlink',
  7: 'shadow inode',
  8: 'socket',
  9: 'whiteout',
  10: 'virtual',
  11: 'virtual directory',
}

/** @type {Record<number, string>} */
export const DIR_TYPES = {
  0: 'undefined',
  1: 'fifo',
  2: 'char device',
  3: 'directory',
  4: 'block device',
  5: 'regular file',
  6: 'symlink',
  7: 'socket',
  8: 'shadow',
  9: 'whiteout',
  10: 'virtual',
  11: 'virtual directory',
}

/** @type {Record<number, string>} */
export const FILE_TYPES = {
  0: 'filesystem',
  1: 'carved',
  2: 'derived',
  3: 'local',
  4: 'unallocated blocks',
  5: 'unused blocks',
  6: 'virtual directory',
  7: 'slack',
  8: 'local directory',
  9: 'layout file',
}

/** @type {Record<number, string>} */
export const KNOWN_STATUS = {
  0: 'unknown',
  1: 'known (NSRL)',
  2: 'known bad / notable',
}

/**
 * tsk_objects.type — nós da árvore que NÃO são arquivos/diretórios.
 * Valores conferidos contra o schema real: 3 = filesystem (bate com tsk_fs_info),
 * 4 = arquivo/diretório (bate com o total de tsk_files).
 * @type {Record<number, string>}
 */
export const OBJECT_TYPES = {
  0: 'data source',
  1: 'volume system',
  2: 'volume/partition',
  3: 'filesystem',
  4: 'file/directory',
  6: 'layout',
  8: 'os account',
}

// blackboard_attributes.value_type
export const VT_STRING = 0
export const VT_INT32 = 1
export const VT_INT64 = 2
export const VT_DOUBLE = 3
export const VT_BYTE = 4
export const VT_DATETIME = 5
export const VT_JSON = 6

/**
 * Epoch seconds -> ISO-8601 UTC. 0/None/null => null.
 * @param {number | null | undefined} value
 * @returns {string | null}
 */
export function ts(value) {
  if (value === null || value === undefined) return null
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0) return null
  const d = new Date(v * 1000)
  if (Number.isNaN(d.getTime())) return null
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/**
 * Decodifica o valor de um blackboard_attribute conforme seu value_type.
 * @param {Record<string, any>} row
 * @returns {any}
 */
export function attrValue(row) {
  const vt = row.value_type
  if (vt === VT_DATETIME) return ts(row.value_int64) ?? row.value_int64
  if (vt === VT_INT64) return row.value_int64
  if (vt === VT_INT32) return row.value_int32
  if (vt === VT_DOUBLE) return row.value_double
  if (vt === VT_BYTE) {
    const raw = row.value_byte
    return raw ? `<binary, ${raw.length ?? raw.byteLength} bytes>` : null
  }
  return row.value_text
}

/**
 * @param {Record<number, string>} map
 * @param {unknown} key
 * @returns {unknown}
 */
export function dec(map, key) {
  if (typeof key === 'number' && key in map) return map[key]
  return key
}

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Builds a synthetic Autopsy case (subset of the real TSK schema) in a temp dir.
 * Returns paths. Used by every test that needs a case DB.
 *
 * @param {string} dir - temp directory to create the case inside
 * @param {{ caseName?: string }} [opts]
 * @returns {{ caseDir: string, dbPath: string, sha256: string }}
 */
export function makeCase(dir, opts = {}) {
  const caseName = opts.caseName ?? 'Caso-Teste'
  const caseDir = join(dir, caseName)
  mkdirSync(caseDir, { recursive: true })
  const dbPath = join(caseDir, 'autopsy.db')
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE tsk_db_info (schema_ver INTEGER, tsk_ver INTEGER);
    CREATE TABLE tsk_db_info_extended (name TEXT, value TEXT);
    CREATE TABLE data_source_info (obj_id INTEGER, device_id TEXT, time_zone TEXT);
    CREATE TABLE tsk_image_names (obj_id INTEGER, name TEXT, sequence INTEGER);
    CREATE TABLE tsk_objects (obj_id INTEGER, par_obj_id INTEGER, type INTEGER);
    CREATE TABLE tsk_files (
      obj_id INTEGER, data_source_obj_id INTEGER, parent_path TEXT, name TEXT,
      extension TEXT, meta_type INTEGER, dir_type INTEGER, type INTEGER, size INTEGER,
      mtime REAL, atime REAL, ctime REAL, crtime REAL,
      md5 TEXT, sha256 TEXT, sha1 TEXT, known INTEGER, mime_type TEXT,
      uid INTEGER, gid INTEGER, meta_addr INTEGER
    );
    CREATE TABLE blackboard_artifact_types (
      artifact_type_id INTEGER, type_name TEXT, display_name TEXT, category TEXT
    );
    CREATE TABLE blackboard_artifacts (
      artifact_id INTEGER, obj_id INTEGER, artifact_type_id INTEGER, data_source_obj_id INTEGER
    );
    CREATE TABLE blackboard_attribute_types (
      attribute_type_id INTEGER, type_name TEXT, display_name TEXT
    );
    CREATE TABLE blackboard_attributes (
      artifact_id INTEGER, attribute_type_id INTEGER, value_type INTEGER,
      value_text TEXT, value_int32 INTEGER, value_int64 INTEGER, value_double REAL, value_byte BLOB
    );
    CREATE TABLE tag_names (
      tag_name_id INTEGER, display_name TEXT, description TEXT, color TEXT, known_status INTEGER
    );
    CREATE TABLE file_tags (
      tag_name_id INTEGER, obj_id INTEGER, comment TEXT, begin_byte_offset INTEGER, end_byte_offset INTEGER
    );
    CREATE TABLE artifact_tags (tag_name_id INTEGER, artifact_id INTEGER);
    CREATE TABLE os_accounts (
      os_account_obj_id INTEGER, data_source_obj_id INTEGER, identifier TEXT,
      display_name TEXT, realm_scope TEXT, login_name TEXT,
      creation_date REAL, deletion_date REAL, account_status TEXT, domain TEXT
    );
    CREATE TABLE keyword_search_runs (id INTEGER, config_name TEXT, list_name TEXT, device_id TEXT, run_time REAL);
    CREATE TABLE keyword_hits (
      id INTEGER, keyword_search_run_id INTEGER, keyword_list_id INTEGER, keyword_id INTEGER,
      obj_id INTEGER, artifact_id INTEGER, offset INTEGER, source TEXT, excerpt TEXT
    );
  `)

  db.exec(`
    INSERT INTO tsk_db_info VALUES (800, 90);
    INSERT INTO tsk_db_info_extended VALUES ('CaseName', '${caseName}');
    INSERT INTO tsk_db_info_extended VALUES ('Examiner', 'Fulano');
    INSERT INTO tsk_db_info_extended VALUES ('CaseNumber', '2026-001');
    INSERT INTO tsk_db_info_extended VALUES ('CreationDate', '2026-01-15');
    INSERT INTO data_source_info VALUES (1, 'vboxdisk1', 'America/Sao_Paulo');
    INSERT INTO tsk_image_names VALUES (1, 'img_disk.E01', 0);
    INSERT INTO tsk_objects VALUES (1, NULL, 0), (10, 1, 2), (11, 10, 4), (12, 10, 4);
    INSERT INTO tsk_files VALUES
      (1, 1, '/', 'img_disk.E01', '', 11, 11, 9, NULL, 1700000000, 1700000000, 1700000000, 1700000000,
       NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL),
      (10, 1, '/img_disk.E01/', 'vol_vol2', '', 2, 3, 0, NULL, 1700000001, 1700000001, 1700000001, 1700000001,
       NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL),
      (11, 1, '/img_disk.E01/vol_vol2/Users/alice/', 'notes.txt', 'txt', 1, 5, 0, 123,
       1700001000, 1700002000, 1700003000, 1700004000,
       'd41d8cd98f00b204e9800998ecf8427e', 'FILE_SHA256_AAA', 'sha1-aaa', 0, 'text/plain', 1000, 1000, 500),
      (12, 1, '/img_disk.E01/vol_vol2/Users/alice/', 'secret.docx', 'docx', 1, 5, 0, 99999,
       1700005000, 1700006000, 1700007000, 1700008000,
       'd41d8cd98f00b204e9800998ecf8427e', 'FILE_SHA256_BBB', 'sha1-bbb', 2, 'application/msword', 1000, 1000, 501);
    INSERT INTO blackboard_artifact_types VALUES
      (4, 'TSK_WEB_HISTORY', 'Web History', 'Web'),
      (7, 'TSK_EMAIL_MSG', 'Email Message', 'Communication'),
      (12, 'TSK_MESSAGE', 'Message', 'Communication');
    INSERT INTO blackboard_artifacts VALUES
      (1, 11, 4, 1),
      (2, 12, 7, 1),
      (10, 11, 12, 1),
      (11, 11, 12, 1),
      (12, 12, 12, 1);
    INSERT INTO blackboard_attribute_types VALUES
      (1, 'TSK_URL', 'URL'),
      (2, 'TSK_DATETIME_ACCESSED', 'Date Accessed'),
      (3, 'TSK_EMAIL_FROM', 'From'),
      (10, 'TSK_PHONE_NUMBER', 'Phone Number'),
      (11, 'TSK_TEXT', 'Message'),
      (12, 'TSK_DATETIME_SENT', 'Date Sent'),
      (13, 'TSK_DIRECTION', 'Direction');
    INSERT INTO blackboard_attributes VALUES
      (1, 1, 0, 'https://bitcoin.example/wallet', NULL, NULL, NULL, NULL),
      (1, 2, 5, NULL, NULL, 1700001500, NULL, NULL),
      (2, 3, 0, 'bob@corp.example', NULL, NULL, NULL, NULL),
      (10, 10, 0, '+5511999991111', NULL, NULL, NULL, NULL),
      (10, 11, 0, 'oi, tudo bem?', NULL, NULL, NULL, NULL),
      (10, 12, 5, NULL, NULL, 1700002000, NULL, NULL),
      (10, 13, 0, 'INCOMING', NULL, NULL, NULL, NULL),
      (11, 10, 0, '+5511999991111', NULL, NULL, NULL, NULL),
      (11, 11, 0, 'podemos conversar? nao conta pra ninguem', NULL, NULL, NULL, NULL),
      (11, 12, 5, NULL, NULL, 1700003000, NULL, NULL),
      (11, 13, 0, 'OUTGOING', NULL, NULL, NULL, NULL),
      (12, 10, 0, '+5511988882222', NULL, NULL, NULL, NULL),
      (12, 11, 0, 'manda foto', NULL, NULL, NULL, NULL),
      (12, 12, 5, NULL, NULL, 1700004000, NULL, NULL),
      (12, 13, 0, 'INCOMING', NULL, NULL, NULL, NULL);
    INSERT INTO tag_names VALUES (1, 'Interessante', 'marcado na analise', '#FF0000', 2);
    INSERT INTO file_tags VALUES (1, 11, NULL, NULL, NULL);
    INSERT INTO artifact_tags VALUES (1, 2);
    INSERT INTO os_accounts VALUES (1, 1, 'alice', 'Alice Admin', 'WINDOWS', 'alice', 0, 0, 'enabled', 'HOME');
    INSERT INTO keyword_search_runs VALUES (1, 'cfg-1', 'lista-1', 'vboxdisk1', 1700009000);
    INSERT INTO keyword_hits VALUES (1, 1, 1, 1, 11, NULL, 42, 'latin-1', 'excerpt bitcoin mention here');
  `)

  db.close()
  const sha256 = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
  return { caseDir, dbPath, sha256 }
}

/**
 * Creates fake "exported files" from Autopsy, matching content SHA-256 to
 * tsk_files.sha256 values so content tools can resolve them.
 *
 * @param {string} dir - directory to write exported files into
 * @param {Array<{ name: string, content: string | Uint8Array }>} entries
 * @returns {{ dir: string, bySha: Record<string, string> }}
 */
export function makeExportedFiles(dir, entries) {
  const exportDir = join(dir, 'Export')
  mkdirSync(exportDir, { recursive: true })
  /** @type {Record<string, string>} */
  const bySha = {}
  for (const e of entries) {
    const p = join(exportDir, e.name)
    writeFileSync(p, e.content)
    bySha[sha256Of(e.content)] = p
  }
  return { dir: exportDir, bySha }
}

/** @param {string | Uint8Array} data @returns {string} */
export function sha256Of(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Variante "legacy" (schema 9, como nos cases reais do Autopsy 4.x):
 * sem file_tags/artifact_tags/keyword_hits/os_accounts; usa content_tags,
 * blackboard_artifact_tags, tag_names.knownStatus e tsk_os_accounts.
 *
 * @param {string} dir
 * @param {{ caseName?: string }} [opts]
 * @returns {{ caseDir: string, dbPath: string }}
 */
export function makeLegacyCase(dir, opts = {}) {
  const caseName = opts.caseName ?? 'Legacy-Case'
  const caseDir = join(dir, caseName)
  mkdirSync(caseDir, { recursive: true })
  const dbPath = join(caseDir, 'autopsy.db')
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE tsk_db_info (schema_ver INTEGER, tsk_ver INTEGER, schema_minor_ver INTEGER);
    CREATE TABLE tsk_db_info_extended (name TEXT, value TEXT);
    CREATE TABLE data_source_info (obj_id INTEGER, device_id TEXT, time_zone TEXT,
      acquisition_details TEXT, added_date_time REAL, acquisition_tool_name TEXT, host_id INTEGER);
    CREATE TABLE tsk_image_names (obj_id INTEGER, name TEXT, sequence INTEGER);
    CREATE TABLE tsk_objects (obj_id INTEGER, par_obj_id INTEGER, type INTEGER);
    CREATE TABLE tsk_fs_info (obj_id INTEGER, img_offset INTEGER, fs_type INTEGER, block_size INTEGER);
    CREATE TABLE tsk_files (
      obj_id INTEGER, fs_obj_id INTEGER, data_source_obj_id INTEGER, name TEXT,
      meta_addr INTEGER, type INTEGER, dir_type INTEGER, meta_type INTEGER,
      size INTEGER, ctime REAL, crtime REAL, atime REAL, mtime REAL, mode INTEGER,
      uid INTEGER, gid INTEGER, md5 TEXT, sha256 TEXT, sha1 TEXT, known INTEGER,
      parent_path TEXT, mime_type TEXT, extension TEXT, owner_uid INTEGER,
      os_account_obj_id INTEGER, collected INTEGER
    );
    CREATE TABLE blackboard_artifact_types (
      artifact_type_id INTEGER, type_name TEXT, display_name TEXT, category_type TEXT);
    CREATE TABLE blackboard_artifacts (
      artifact_id INTEGER, obj_id INTEGER, artifact_obj_id INTEGER,
      data_source_obj_id INTEGER, artifact_type_id INTEGER, review_status_id INTEGER);
    CREATE TABLE blackboard_attribute_types (
      attribute_type_id INTEGER, type_name TEXT, display_name TEXT, value_type INTEGER);
    CREATE TABLE blackboard_attributes (
      artifact_id INTEGER, artifact_type_id INTEGER, source TEXT, context TEXT,
      attribute_type_id INTEGER, value_type INTEGER, value_byte BLOB, value_text TEXT,
      value_int32 INTEGER, value_int64 INTEGER, value_double REAL);
    CREATE TABLE tag_names (
      tag_name_id INTEGER, display_name TEXT, description TEXT, color TEXT,
      knownStatus INTEGER, tag_set_id INTEGER, rank INTEGER);
    CREATE TABLE content_tags (
      tag_id INTEGER, obj_id INTEGER, tag_name_id INTEGER, comment TEXT,
      begin_byte_offset INTEGER, end_byte_offset INTEGER, examiner_id INTEGER);
    CREATE TABLE blackboard_artifact_tags (
      tag_id INTEGER, artifact_id INTEGER, tag_name_id INTEGER, comment TEXT, examiner_id INTEGER);
    CREATE TABLE tsk_os_accounts (
      os_account_obj_id INTEGER, login_name TEXT, full_name TEXT, realm_id INTEGER,
      addr TEXT, signature TEXT, status INTEGER, type TEXT, created_date REAL,
      db_status INTEGER, merged_into INTEGER);
    CREATE TABLE tsk_os_account_realms (
      id INTEGER, realm_name TEXT, realm_addr TEXT, realm_signature TEXT,
      scope_host_id INTEGER, scope_confidence INTEGER, db_status INTEGER, merged_into INTEGER);
    CREATE TABLE tsk_os_account_instances (
      id INTEGER, os_account_obj_id INTEGER, data_source_obj_id INTEGER, instance_type INTEGER);
    CREATE TABLE tsk_examiners (id INTEGER, login_name TEXT, display_name TEXT);
    CREATE TABLE tsk_event_types (event_type_id INTEGER, display_name TEXT, super_type_id INTEGER);
    CREATE TABLE tsk_event_descriptions (
      event_description_id INTEGER, full_description TEXT, med_description TEXT,
      short_description TEXT, data_source_obj_id INTEGER, content_obj_id INTEGER,
      artifact_id INTEGER, hash_hit INTEGER, tagged INTEGER);
    CREATE TABLE tsk_events (event_id INTEGER, event_type_id INTEGER, event_description_id INTEGER, time INTEGER);
  `)

  db.exec(`
    INSERT INTO tsk_db_info VALUES (9, 68419839, 6);
    INSERT INTO tsk_db_info_extended VALUES ('TSK_VERSION', '68419839');
    INSERT INTO tsk_db_info_extended VALUES ('SCHEMA_MAJOR_VERSION', '9');
    INSERT INTO tsk_db_info_extended VALUES ('SCHEMA_MINOR_VERSION', '6');
    INSERT INTO tsk_examiners VALUES (1, 'analista', 'Analista');
    INSERT INTO data_source_info (obj_id, device_id, time_zone) VALUES (1, 'ddisk', 'America/Sao_Paulo');
    INSERT INTO tsk_image_names VALUES (1, 'disco.img', 0);
    INSERT INTO tsk_objects VALUES (1, NULL, 0), (2, 1, 1), (3, 2, 2), (5, 3, 3),
      (6, 5, 4), (10, 6, 4), (11, 10, 4);
    INSERT INTO tsk_fs_info VALUES (5, 1048576, 8, 512);
    INSERT INTO tsk_files (obj_id, data_source_obj_id, name, meta_type, dir_type, type, size,
      mtime, atime, ctime, crtime, uid, gid, md5, sha256, sha1, known, parent_path, mime_type,
      extension, owner_uid, os_account_obj_id, collected) VALUES
      (6, 1, '', 2, 3, 0, NULL, 1700000050, 1700000050, 1700000050, 1700000050, NULL, NULL,
       NULL, NULL, NULL, 0, '/', NULL, '', NULL, NULL, NULL),
      (10, 1, 'Users', 2, 3, 0, NULL, 1700000100, 1700000100, 1700000100, 1700000100, NULL, NULL,
       NULL, NULL, NULL, 0, '/', NULL, '', NULL, NULL, NULL),
      (11, 1, 'notes.txt', 1, 5, 0, 123, 1700001000, 1700002000, 1700003000, 1700004000, 1000, 1000,
       'd41d8cd98f00b204e9800998ecf8427e', 'FILE_SHA256_LEGACY', 'sha1-legacy', 0,
       '/Users/alice/', 'text/plain', 'txt', 1000, 900, 1);
    INSERT INTO blackboard_artifact_types VALUES (4, 'TSK_WEB_HISTORY', 'Web History', 'WEB_ACTIVITY');
    INSERT INTO blackboard_attribute_types VALUES (1, 'TSK_URL', 'URL', 0);
    INSERT INTO tag_names VALUES (1, 'Interessante', 'marcado', '#FF0000', 2, 1, 1);
    INSERT INTO content_tags VALUES (1, 11, 1, NULL, NULL, NULL, NULL);
    INSERT INTO blackboard_artifact_tags VALUES (1, 5, 1, NULL, NULL);
    INSERT INTO tsk_os_accounts VALUES
      (900, 'ALICE', 'Alice Admin', 1, 'S-1-5-21-1', 'S-1-5-21-1', 0, NULL, NULL, 0, NULL),
      (901, 'SYSTEM', 'Local System Account', 2, 'S-1-5-18', 'S-1-5-18', 0, NULL, NULL, 0, NULL),
      (910, NULL, NULL, 3, 'S-1-5-21-2166083798-3953003113-1225838991-1002', 'S-1-5-21-2166083798-3953003113-1225838991-1002', 0, NULL, NULL, 0, NULL);
    INSERT INTO tsk_os_account_realms VALUES (1, 'DESKTOP-ALICE', NULL, NULL, NULL, NULL, 0, NULL),
      (2, 'NT AUTHORITY', NULL, NULL, NULL, NULL, 0, NULL),
      (3, 'DESKTOP-JTJ0PN7', NULL, NULL, NULL, NULL, 0, NULL);
    INSERT INTO tsk_os_account_instances VALUES (1, 900, 1, 0), (2, 901, 1, 1);
    INSERT INTO tsk_event_types VALUES (0, 'Event Types', NULL), (1, 'File System', 0);
    INSERT INTO tsk_event_descriptions VALUES
      (1, '/disco.img/Users/alice/notes.txt', NULL, NULL, 1, 11, NULL, 0, 0);
    INSERT INTO tsk_events VALUES
      (1, 1, 1, 1700001000), (2, 1, 1, 1700002000), (3, 1, 1, 1700003000);
  `)

  db.close()
  return { caseDir, dbPath }
}

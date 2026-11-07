#include "DatabaseManager.h"
#include <ArduinoJson.h>
#include <string.h>

DatabaseManager dbManager;
QueueHandle_t dbQueue = NULL;

const char* create_table_sql = 
    "CREATE TABLE IF NOT EXISTS sessions ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, "
    "patient_id TEXT, "
    "timestamp INTEGER, "
    "date_str TEXT, "
    "min_angle REAL, "
    "max_angle REAL, "
    "amplitude REAL, "
    "avg_speed REAL, "
    "smoothness REAL, "
    "flexions_count INTEGER, "
    "session_duration REAL, "
    "session_mode INTEGER DEFAULT 0, "
    "min_pitch REAL, "
    "max_pitch REAL, "
    "mean_roll REAL, "
    "mean_pitch REAL, "
    "sway_rms REAL, "
    "ml_rms REAL, "
    "ap_rms REAL, "
    "stability_pct REAL, "
    "q_fl REAL, "
    "q_fr REAL, "
    "q_bl REAL, "
    "q_br REAL"
    ");";

struct SchemaColumnDef {
    const char* name;
    const char* ddl;
};

static const SchemaColumnDef kExtendedColumns[] = {
    {"session_mode",  "INTEGER DEFAULT 0"},
    {"min_pitch",     "REAL"},
    {"max_pitch",     "REAL"},
    {"mean_roll",     "REAL"},
    {"mean_pitch",    "REAL"},
    {"sway_rms",      "REAL"},
    {"ml_rms",        "REAL"},
    {"ap_rms",        "REAL"},
    {"stability_pct", "REAL"},
    {"q_fl",          "REAL"},
    {"q_fr",          "REAL"},
    {"q_bl",          "REAL"},
    {"q_br",          "REAL"}
};

DatabaseManager::DatabaseManager() {
    db = nullptr;
    usingSD = false;
    dbPathSD = "/sd/rehab.db";
    dbPathFS = "/littlefs/rehab.db";
    cachedUsedBytes = 0;
    cachedTotalBytes = 0;
    cachedLowSpace = false;
    dbMutex = xSemaphoreCreateMutex();
    if (dbMutex == nullptr) {
        Serial.println("[DatabaseManager] FATAL: Failed to create db mutex!");
    }
}

DatabaseManager::~DatabaseManager() {
    close();
    if (dbMutex != nullptr) {
        vSemaphoreDelete(dbMutex);
    }
}

void DatabaseManager::refreshStorageStats() {
    if (usingSD) {
        __atomic_store_n(&cachedUsedBytes, 0U, __ATOMIC_RELAXED);
        __atomic_store_n(&cachedTotalBytes, 0U, __ATOMIC_RELAXED);
        __atomic_store_n(&cachedLowSpace, false, __ATOMIC_RELAXED);
        return;
    }
    const size_t total = LittleFS.totalBytes();
    const size_t used = LittleFS.usedBytes();
    const size_t freeBytes = (total > used) ? (total - used) : 0;
    const bool low = (total > 0) && (freeBytes < static_cast<size_t>(FS_MIN_FREE_BYTES));
    __atomic_store_n(&cachedUsedBytes, static_cast<uint32_t>(used), __ATOMIC_RELAXED);
    __atomic_store_n(&cachedTotalBytes, static_cast<uint32_t>(total), __ATOMIC_RELAXED);
    __atomic_store_n(&cachedLowSpace, low, __ATOMIC_RELAXED);
}

uint32_t DatabaseManager::getUsedBytes() const {
    return __atomic_load_n(&cachedUsedBytes, __ATOMIC_RELAXED);
}

uint32_t DatabaseManager::getTotalBytes() const {
    return __atomic_load_n(&cachedTotalBytes, __ATOMIC_RELAXED);
}

bool DatabaseManager::isStorageLowSpace() const {
    return __atomic_load_n(&cachedLowSpace, __ATOMIC_RELAXED);
}

bool DatabaseManager::init(bool useSD) {
    Serial.println("[DatabaseManager] Initializing...");

    // Memory optimizations for SQLite on ESP32
    sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 0);
    sqlite3_config(SQLITE_CONFIG_LOOKASIDE, 0, 0);
    sqlite3_initialize();

    usingSD = useSD;

    // Determine the active DB path
    const char* activePath = usingSD ? dbPathSD : dbPathFS;

    // If using SD, attempt migration from LittleFS first
    if (usingSD) {
        mergeAndCleanupLittleFS();
    }

    // Open the active database
    int rc = sqlite3_open(activePath, &db);
    if (rc != SQLITE_OK) {
        Serial.printf("[DatabaseManager] Failed to open database at %s: %s\n", activePath, sqlite3_errmsg(db));
        refreshStorageStats();
        return false;
    }

    // Set busy timeout to 1000ms. If DB is locked by a concurrent read, it will wait up to 1s instead of failing immediately.
    sqlite3_busy_timeout(db, 1000);
    
    Serial.printf("[DatabaseManager] Database opened at %s\n", activePath);

    // Create tables and run idempotent column migrations if needed
    if (!createTables()) {
        refreshStorageStats();
        return false;
    }

    refreshStorageStats();
    return true;
}

bool DatabaseManager::hasColumn(sqlite3* handle, const char* schemaName, const char* columnName) {
    if (!handle || !schemaName || !columnName) return false;
    char pragmaSql[96];
    snprintf(pragmaSql, sizeof(pragmaSql), "PRAGMA %s.table_info(sessions);", schemaName);

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(handle, pragmaSql, -1, &stmt, nullptr) != SQLITE_OK) {
        return false;
    }

    bool found = false;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const unsigned char* colText = sqlite3_column_text(stmt, 1);
        if (colText && strcmp(reinterpret_cast<const char*>(colText), columnName) == 0) {
            found = true;
            break;
        }
    }
    sqlite3_finalize(stmt);
    return found;
}

bool DatabaseManager::ensureSchemaColumns(sqlite3* handle, const char* schemaName) {
    if (!handle || !schemaName) return false;
    const size_t count = sizeof(kExtendedColumns) / sizeof(kExtendedColumns[0]);
    for (size_t i = 0; i < count; i++) {
        if (!hasColumn(handle, schemaName, kExtendedColumns[i].name)) {
            char alterSql[160];
            snprintf(alterSql, sizeof(alterSql), "ALTER TABLE %s.sessions ADD COLUMN %s %s;",
                     schemaName, kExtendedColumns[i].name, kExtendedColumns[i].ddl);
            char* zErrMsg = nullptr;
            int rc = sqlite3_exec(handle, alterSql, nullptr, nullptr, &zErrMsg);
            if (rc != SQLITE_OK) {
                Serial.printf("[DatabaseManager] Schema migration failed (%s): %s\n",
                              kExtendedColumns[i].name, zErrMsg ? zErrMsg : "unknown");
                if (zErrMsg) sqlite3_free(zErrMsg);
                return false;
            }
            Serial.printf("[DatabaseManager] Migrated column '%s' on %s.sessions\n",
                          kExtendedColumns[i].name, schemaName);
        }
    }
    return true;
}

bool DatabaseManager::createTables() {
    if (!db) return false;
    if (!execQuery(create_table_sql)) return false;
    return ensureSchemaColumns(db, "main");
}

bool DatabaseManager::execQuery(const char* sql) {
    char* zErrMsg = 0;
    int rc = sqlite3_exec(db, sql, NULL, 0, &zErrMsg);
    if (rc != SQLITE_OK) {
        Serial.printf("[DatabaseManager] SQL error: %s\n", zErrMsg);
        sqlite3_free(zErrMsg);
        return false;
    }
    return true;
}

bool DatabaseManager::mergeAndCleanupLittleFS() {
    // Check if the LittleFS db file exists
    if (!LittleFS.exists("/rehab.db")) {
        return true; // Nothing to migrate
    }

    Serial.println("[DatabaseManager] Found existing db on LittleFS. Starting migration to SD...");

    // Open the SD database
    sqlite3* sd_db = nullptr;
    if (sqlite3_open(dbPathSD, &sd_db) != SQLITE_OK) {
        Serial.println("[DatabaseManager] Could not open SD db for migration.");
        if (sd_db) sqlite3_close(sd_db);
        return false;
    }

    // Ensure full current schema exists on SD before inserting
    char* zErrMsg = 0;
    sqlite3_exec(sd_db, create_table_sql, NULL, 0, &zErrMsg);
    if (zErrMsg) {
        sqlite3_free(zErrMsg);
        zErrMsg = 0;
    }
    ensureSchemaColumns(sd_db, "main");

    // ATTACH LittleFS db (read-only inspection avoids SQLITE_FULL if LittleFS was near capacity)
    const char* attach_sql = "ATTACH DATABASE '/littlefs/rehab.db' AS fs_db;";
    if (sqlite3_exec(sd_db, attach_sql, NULL, 0, &zErrMsg) != SQLITE_OK) {
        Serial.printf("[DatabaseManager] Failed to attach fs_db: %s\n", zErrMsg);
        sqlite3_free(zErrMsg);
        sqlite3_close(sd_db);
        return false;
    }

    const bool fsHasExtendedSchema = hasColumn(sd_db, "fs_db", "session_mode") && hasColumn(sd_db, "fs_db", "q_br");

    // Use a transaction for safe migration
    sqlite3_exec(sd_db, "BEGIN TRANSACTION;", NULL, 0, NULL);

    const char* copy_sql = fsHasExtendedSchema
        ? "INSERT INTO main.sessions "
          "(patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration, "
          "session_mode, min_pitch, max_pitch, mean_roll, mean_pitch, sway_rms, ml_rms, ap_rms, stability_pct, q_fl, q_fr, q_bl, q_br) "
          "SELECT patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration, "
          "COALESCE(session_mode, 0), min_pitch, max_pitch, mean_roll, mean_pitch, sway_rms, ml_rms, ap_rms, stability_pct, q_fl, q_fr, q_bl, q_br "
          "FROM fs_db.sessions;"
        : "INSERT INTO main.sessions "
          "(patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration, session_mode) "
          "SELECT patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration, 0 "
          "FROM fs_db.sessions;";
                           
    int rc = sqlite3_exec(sd_db, copy_sql, NULL, 0, &zErrMsg);
    if (rc != SQLITE_OK) {
        Serial.printf("[DatabaseManager] Failed to copy data: %s\n", zErrMsg);
        sqlite3_free(zErrMsg);
        sqlite3_exec(sd_db, "ROLLBACK;", NULL, 0, NULL);
    } else {
        sqlite3_exec(sd_db, "COMMIT;", NULL, 0, NULL);
        Serial.println("[DatabaseManager] Migration successful!");
    }

    sqlite3_exec(sd_db, "DETACH DATABASE fs_db;", NULL, 0, NULL);
    sqlite3_close(sd_db);

    if (rc == SQLITE_OK) {
        Serial.println("[DatabaseManager] Deleting LittleFS database to free up space...");
        LittleFS.remove("/rehab.db");
    }

    return rc == SQLITE_OK;
}

bool DatabaseManager::saveSession(const SessionRecord& rec) {
    if (dbQueue != NULL) {
        if (xQueueSend(dbQueue, &rec, 0) == pdTRUE) {
            return true;
        }
        Serial.println("[DatabaseManager] WARNING: dbQueue full! Session record dropped.");
    }
    return false;
}

bool DatabaseManager::saveSessionDb(const SessionRecord& rec) {
    if (!db) return false;

    if (!usingSD) {
        refreshStorageStats();
        if (isStorageLowSpace()) {
            Serial.println("[DatabaseManager] ERROR: LittleFS free space below 100 KiB reserve; refusing write to protect existing records. Insert SD card.");
            return false;
        }
    }

    const char* sql =
        "INSERT INTO sessions ("
        "patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration, "
        "session_mode, min_pitch, max_pitch, mean_roll, mean_pitch, sway_rms, ml_rms, ap_rms, stability_pct, q_fl, q_fr, q_bl, q_br"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);";
    
    int maxRetries = 3;
    for (int attempt = 1; attempt <= maxRetries; attempt++) {
        xSemaphoreTake(dbMutex, portMAX_DELAY);
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) {
            Serial.printf("[DatabaseManager] Attempt %d: Failed to prepare insert statement: %s\n", attempt, sqlite3_errmsg(db));
            xSemaphoreGive(dbMutex);
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        sqlite3_bind_text(stmt, 1, rec.patientId, -1, SQLITE_STATIC);
        sqlite3_bind_int(stmt, 2, rec.timestamp);
        sqlite3_bind_text(stmt, 3, rec.dateStr, -1, SQLITE_STATIC);
        sqlite3_bind_double(stmt, 4, rec.minAngle);
        sqlite3_bind_double(stmt, 5, rec.maxAngle);
        sqlite3_bind_double(stmt, 6, rec.amplitude);
        sqlite3_bind_double(stmt, 7, rec.avgSpeed);
        sqlite3_bind_double(stmt, 8, rec.smoothness);
        sqlite3_bind_int(stmt, 9, rec.flexionsCount);
        sqlite3_bind_double(stmt, 10, rec.sessionDuration);
        sqlite3_bind_int(stmt, 11, rec.sessionMode);

        if (rec.sessionMode == SESSION_MODE_WRIST) {
            for (int col = 12; col <= 23; col++) {
                sqlite3_bind_null(stmt, col);
            }
        } else {
            sqlite3_bind_double(stmt, 12, rec.minPitch);
            sqlite3_bind_double(stmt, 13, rec.maxPitch);
            sqlite3_bind_double(stmt, 14, rec.meanRoll);
            sqlite3_bind_double(stmt, 15, rec.meanPitch);
            sqlite3_bind_double(stmt, 16, rec.swayRms);
            sqlite3_bind_double(stmt, 17, rec.mlRms);
            sqlite3_bind_double(stmt, 18, rec.apRms);
            sqlite3_bind_double(stmt, 19, rec.stabilityPct);
            sqlite3_bind_double(stmt, 20, rec.qFL);
            sqlite3_bind_double(stmt, 21, rec.qFR);
            sqlite3_bind_double(stmt, 22, rec.qBL);
            sqlite3_bind_double(stmt, 23, rec.qBR);
        }

        int rc = sqlite3_step(stmt);
        sqlite3_finalize(stmt);
        xSemaphoreGive(dbMutex);

        if (rc == SQLITE_DONE) {
            refreshStorageStats();
            Serial.println("[DatabaseManager] Session saved to database.");
            return true;
        }
        
        Serial.printf("[DatabaseManager] Attempt %d failed. SQLITE RC: %d, Error: %s\n", attempt, rc, sqlite3_errmsg(db));
        if (attempt < maxRetries) {
            vTaskDelay(pdMS_TO_TICKS(150));
        }
    }
    
    refreshStorageStats();
    Serial.println("[DatabaseManager] CRITICAL: Failed to save session after all retries.");
    return false;
}

sqlite3_stmt* DatabaseManager::prepareSessionsQuery(int limit, int offset) {
    if (!db) return nullptr;
    
    char sql[768];
    snprintf(sql, sizeof(sql), 
        "SELECT id, patient_id AS patientId, timestamp, date_str AS dateStr, "
        "min_angle AS minAngle, max_angle AS maxAngle, amplitude, "
        "avg_speed AS avgSpeed, smoothness, flexions_count AS flexionsCount, "
        "session_duration AS sessionDuration, COALESCE(session_mode, 0) AS sessionMode, "
        "min_pitch, max_pitch, mean_roll, mean_pitch, "
        "sway_rms, ml_rms, ap_rms, stability_pct, "
        "q_fl, q_fr, q_bl, q_br "
        "FROM sessions ORDER BY timestamp DESC LIMIT %d OFFSET %d;", 
        limit, offset);
    
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        Serial.printf("[DatabaseManager] Failed to prepare statement: %s\n", sqlite3_errmsg(db));
        xSemaphoreGive(dbMutex);
        return nullptr;
    }
    xSemaphoreGive(dbMutex);
    return stmt;
}

int DatabaseManager::countSessionsPage(int limit, int offset) {
    if (!db) return 0;
    char sql[256];
    snprintf(sql, sizeof(sql), "SELECT COUNT(*) FROM (SELECT 1 FROM sessions LIMIT %d OFFSET %d);", limit, offset);
    
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    sqlite3_stmt* stmt = nullptr;
    int count = 0;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            count = sqlite3_column_int(stmt, 0);
        }
        sqlite3_finalize(stmt);
    }
    xSemaphoreGive(dbMutex);
    return count;
}

int DatabaseManager::stepStatement(sqlite3_stmt* stmt) {
    if (!stmt) return SQLITE_MISUSE;
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    int rc = sqlite3_step(stmt);
    xSemaphoreGive(dbMutex);
    return rc;
}

int DatabaseManager::stepSessionRow(sqlite3_stmt* stmt, JsonDocument& doc) {
    if (!stmt) return SQLITE_MISUSE;
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    int rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
        const unsigned char* patientText = sqlite3_column_text(stmt, 1);
        const unsigned char* dateText = sqlite3_column_text(stmt, 3);
        const int mode = sqlite3_column_int(stmt, 11);

        doc["id"] = sqlite3_column_int(stmt, 0);
        doc["patientId"] = patientText ? reinterpret_cast<const char*>(patientText) : "";
        doc["timestamp"] = sqlite3_column_int(stmt, 2);
        doc["dateStr"] = dateText ? reinterpret_cast<const char*>(dateText) : "";
        doc["minAngle"] = sqlite3_column_double(stmt, 4);
        doc["maxAngle"] = sqlite3_column_double(stmt, 5);
        doc["amplitude"] = sqlite3_column_double(stmt, 6);
        doc["avgSpeed"] = sqlite3_column_double(stmt, 7);
        doc["smoothness"] = sqlite3_column_double(stmt, 8);
        doc["flexionsCount"] = sqlite3_column_int(stmt, 9);
        doc["sessionDuration"] = sqlite3_column_double(stmt, 10);
        doc["sessionMode"] = mode;

        // Sparse MsgPack serialization: emit 4-way balance columns only on balance rows
        if (mode != SESSION_MODE_WRIST) {
            doc["minPitch"] = sqlite3_column_double(stmt, 12);
            doc["maxPitch"] = sqlite3_column_double(stmt, 13);
            doc["meanRoll"] = sqlite3_column_double(stmt, 14);
            doc["meanPitch"] = sqlite3_column_double(stmt, 15);
            doc["swayRms"] = sqlite3_column_double(stmt, 16);
            doc["mlRms"] = sqlite3_column_double(stmt, 17);
            doc["apRms"] = sqlite3_column_double(stmt, 18);
            doc["stabilityPct"] = sqlite3_column_double(stmt, 19);
            doc["qFL"] = sqlite3_column_double(stmt, 20);
            doc["qFR"] = sqlite3_column_double(stmt, 21);
            doc["qBL"] = sqlite3_column_double(stmt, 22);
            doc["qBR"] = sqlite3_column_double(stmt, 23);
        }
    }
    xSemaphoreGive(dbMutex);
    return rc;
}

void DatabaseManager::finalizeStatement(sqlite3_stmt* stmt) {
    if (!stmt) return;
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    sqlite3_finalize(stmt);
    xSemaphoreGive(dbMutex);
}

bool DatabaseManager::deletePatient(String patientId) {
    if (!db || patientId.isEmpty()) return false;
    
    const char* sql = "DELETE FROM sessions WHERE patient_id = ?;";
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    sqlite3_stmt* stmt = nullptr;
    
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        Serial.printf("[DatabaseManager] Failed to prepare deletePatient statement: %s\n", sqlite3_errmsg(db));
        xSemaphoreGive(dbMutex);
        return false;
    }
    
    sqlite3_bind_text(stmt, 1, patientId.c_str(), -1, SQLITE_STATIC);
    
    bool success = false;
    if (sqlite3_step(stmt) == SQLITE_DONE) {
        success = true;
    } else {
        Serial.printf("[DatabaseManager] Failed to execute deletePatient: %s\n", sqlite3_errmsg(db));
    }
    
    sqlite3_finalize(stmt);
    xSemaphoreGive(dbMutex);
    if (success) refreshStorageStats();
    return success;
}

bool DatabaseManager::deleteSession(int id) {
    if (!db) return false;
    
    char sql[128];
    snprintf(sql, sizeof(sql), "DELETE FROM sessions WHERE id = %d;", id);
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    bool result = execQuery(sql);
    xSemaphoreGive(dbMutex);
    if (result) refreshStorageStats();
    return result;
}

void DatabaseManager::close() {
    if (db) {
        sqlite3_close(db);
        db = nullptr;
    }
}

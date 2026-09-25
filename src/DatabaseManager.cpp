#include "DatabaseManager.h"
#include <ArduinoJson.h>

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
    "session_duration REAL"
    ");";

DatabaseManager::DatabaseManager() {
    db = nullptr;
    usingSD = false;
    dbPathSD = "/sd/rehab.db";
    dbPathFS = "/littlefs/rehab.db";
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
        return false;
    }

    // Set busy timeout to 1000ms. If DB is locked by a concurrent read, it will wait up to 1s instead of failing immediately.
    sqlite3_busy_timeout(db, 1000);
    
    Serial.printf("[DatabaseManager] Database opened at %s\n", activePath);

    // Create tables if they don't exist
    if (!createTables()) {
        return false;
    }

    return true;
}

bool DatabaseManager::createTables() {
    if (!db) return false;
    return execQuery(create_table_sql);
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
    sqlite3* sd_db;
    if (sqlite3_open(dbPathSD, &sd_db) != SQLITE_OK) {
        Serial.println("[DatabaseManager] Could not open SD db for migration.");
        return false;
    }

    // Ensure table exists on SD before inserting
    char* zErrMsg = 0;
    sqlite3_exec(sd_db, create_table_sql, NULL, 0, &zErrMsg);
    if (zErrMsg) sqlite3_free(zErrMsg);

    // ATTACH LittleFS db
    const char* attach_sql = "ATTACH DATABASE '/littlefs/rehab.db' AS fs_db;";
    if (sqlite3_exec(sd_db, attach_sql, NULL, 0, &zErrMsg) != SQLITE_OK) {
        Serial.printf("[DatabaseManager] Failed to attach fs_db: %s\n", zErrMsg);
        sqlite3_free(zErrMsg);
        sqlite3_close(sd_db);
        return false;
    }

    // Use a transaction for safe migration
    sqlite3_exec(sd_db, "BEGIN TRANSACTION;", NULL, 0, NULL);

    const char* copy_sql = "INSERT INTO main.sessions "
                           "(patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration) "
                           "SELECT patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration "
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
        return xQueueSend(dbQueue, &rec, 0) == pdTRUE;
    }
    return false;
}

bool DatabaseManager::saveSessionDb(const SessionRecord& rec) {
    if (!db) return false;

    const char* sql = "INSERT INTO sessions (patient_id, timestamp, date_str, min_angle, max_angle, amplitude, avg_speed, smoothness, flexions_count, session_duration) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);";
    
    int maxRetries = 3;
    for (int attempt = 1; attempt <= maxRetries; attempt++) {
        xSemaphoreTake(dbMutex, portMAX_DELAY);
        sqlite3_stmt* stmt;
        if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) {
            Serial.printf("[DatabaseManager] Attempt %d: Failed to prepare insert statement: %s\n", attempt, sqlite3_errmsg(db));
            xSemaphoreGive(dbMutex);
            vTaskDelay(pdMS_TO_TICKS(100));
            continue; // try again
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

        int rc = sqlite3_step(stmt);
        sqlite3_finalize(stmt);
        xSemaphoreGive(dbMutex);

        if (rc == SQLITE_DONE) {
            Serial.println("[DatabaseManager] Session saved to database.");
            return true;
        }
        
        Serial.printf("[DatabaseManager] Attempt %d failed. SQLITE RC: %d, Error: %s\n", attempt, rc, sqlite3_errmsg(db));
        if (attempt < maxRetries) {
            vTaskDelay(pdMS_TO_TICKS(150)); // wait before next attempt
        }
    }
    
    Serial.println("[DatabaseManager] CRITICAL: Failed to save session after all retries.");
    return false;
}

sqlite3_stmt* DatabaseManager::prepareSessionsQuery(int limit, int offset) {
    if (!db) return nullptr;
    
    char sql[512];
    snprintf(sql, sizeof(sql), 
        "SELECT id, patient_id AS patientId, timestamp, date_str AS dateStr, "
        "min_angle AS minAngle, max_angle AS maxAngle, amplitude, "
        "avg_speed AS avgSpeed, smoothness, flexions_count AS flexionsCount, "
        "session_duration AS sessionDuration "
        "FROM sessions ORDER BY timestamp DESC LIMIT %d OFFSET %d;", 
        limit, offset);
    
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    sqlite3_stmt* stmt;
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
    sqlite3_stmt* stmt;
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
    sqlite3_stmt* stmt;
    
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
    return success;
}

bool DatabaseManager::deleteSession(int id) {
    if (!db) return false;
    
    char sql[128];
    snprintf(sql, sizeof(sql), "DELETE FROM sessions WHERE id = %d;", id);
    xSemaphoreTake(dbMutex, portMAX_DELAY);
    bool result = execQuery(sql);
    xSemaphoreGive(dbMutex);
    return result;
}

void DatabaseManager::close() {
    if (db) {
        sqlite3_close(db);
        db = nullptr;
    }
}

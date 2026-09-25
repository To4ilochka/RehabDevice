#ifndef DATABASE_MANAGER_H
#define DATABASE_MANAGER_H

#include <Arduino.h>
#include <sqlite3.h>
#include <LittleFS.h>
#include <freertos/semphr.h>
#include "Config.h"
#include "AnalyticsEngine.h" // For SessionRecord

class DatabaseManager {
public:
    DatabaseManager();
    ~DatabaseManager();

    // Initialize SQLite
    bool init(bool useSD);

    // Create a new session record by pushing to FreeRTOS queue
    bool saveSession(const SessionRecord& rec);

    // Actual blocking DB write method (called from dbTask)
    bool saveSessionDb(const SessionRecord& rec);

    // Prepare statement for paginated sessions retrieval
    sqlite3_stmt* prepareSessionsQuery(int limit = 50, int offset = 0);
    
    // Get exact row count for a paginated query (needed for MsgPack array header)
    int countSessionsPage(int limit, int offset);

    // Delete all sessions for a specific patient
    bool deletePatient(String patientId);

    // Delete a single session by id
    bool deleteSession(int id);

    // Step a prepared statement, serialized against other DB access (used for
    // long-lived streaming queries whose sqlite3_step calls happen across
    // multiple AsyncTCP callback invocations).
    int stepStatement(sqlite3_stmt* stmt);

    // Finalize a prepared statement, serialized against other DB access
    void finalizeStatement(sqlite3_stmt* stmt);

    // Check if SD is currently being used
    bool isSDAvailable() const { return usingSD; }

    // Close database gracefully
    void close();

private:
    sqlite3* db;
    bool usingSD;
    const char* dbPathSD;
    const char* dbPathFS;

    // Serializes all sqlite3 API calls on `db`: the connection is shared between
    // dbTask (writes) and AsyncWebServer request handlers (reads), which run in
    // different FreeRTOS tasks/cores.
    SemaphoreHandle_t dbMutex;

    // Helper to execute a query without results
    bool execQuery(const char* sql);
    
    // Attempt to merge from FS to SD if needed
    bool mergeAndCleanupLittleFS();
    
    // Ensure table exists
    bool createTables();
};

extern DatabaseManager dbManager;
extern QueueHandle_t dbQueue;

#endif // DATABASE_MANAGER_H

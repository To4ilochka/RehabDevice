#ifndef MEMORY_FS_H
#define MEMORY_FS_H

#include <Arduino.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <vector>
#include <map>
#include <set>
#include "Config.h"

// Patient session structure
struct SessionRecord {
    String filename;
    String patientId;
    unsigned long timestamp;
    String dateStr;
    float minAngle;
    float maxAngle;
    float amplitude;
    float avgSpeed;
    float smoothness;
    int flexionsCount;
    float holdingTime;
};

class MemoryFS {
public:
    MemoryFS();
    
    bool init();
    size_t getTotalBytes();
    size_t getUsedBytes();
    size_t getFreeBytes();
    
    bool saveSession(const SessionRecord& record);
    bool checkAndCleanStorage();
    std::vector<SessionRecord> getAllSessions();
    String generateCSV();
    String getSessionsJSON();

    size_t getPatientsCount();
    bool getPatientSessionsChunk(size_t patientIndex, String& outJson);

    bool deleteSession(const String& filenameOrKey, unsigned long timestamp = 0);
    bool deletePatient(const String& patientId);
    bool rebuildIndex();

private:
    std::multimap<uint32_t, uint16_t> hashToIds;
    uint16_t nextPatientId;
    bool indexLoaded;

    uint32_t hashName(const String& name);
    uint16_t findPatientId(const String& name);
    uint16_t getOrCreatePatientId(const String& name);
    bool fastReadLine(File& file, char* buffer, size_t maxLen);
    bool findOldestSessionFast(String& outFilepath, unsigned long& outTimestamp);
};

#endif // MEMORY_FS_H

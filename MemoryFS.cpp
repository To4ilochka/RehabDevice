#include "MemoryFS.h"
#include <algorithm>

MemoryFS::MemoryFS() : nextPatientId(1), indexLoaded(false) {}

bool MemoryFS::init() {
    Serial.println("[MemoryFS] Initializing LittleFS and loading hash index...");
    if (!LittleFS.begin(true)) {
        Serial.println("[MemoryFS] Error mounting LittleFS! Formatting...");
        if (!LittleFS.format() || !LittleFS.begin()) {
            Serial.println("[MemoryFS] Critical LittleFS error!");
            return false;
        }
    }
    return rebuildIndex();
}

size_t MemoryFS::getTotalBytes() {
    return LittleFS.totalBytes();
}

size_t MemoryFS::getUsedBytes() {
    return LittleFS.usedBytes();
}

size_t MemoryFS::getFreeBytes() {
    size_t total = getTotalBytes();
    size_t used = getUsedBytes();
    return (total > used) ? (total - used) : 0;
}

uint32_t MemoryFS::hashName(const String& name) {
    uint32_t hash = 2166136261UL;
    for (size_t i = 0; i < name.length(); i++) {
        hash ^= (uint8_t)name[i];
        hash *= 16777619UL;
    }
    return hash;
}

bool MemoryFS::fastReadLine(File& file, char* buffer, size_t maxLen) {
    if (!file || !file.available() || maxLen < 2) return false;
    size_t pos = 0;
    while (file.available() && pos < maxLen - 1) {
        char c = (char)file.read();
        if (c == '\r') continue;
        if (c == '\n') break;
        buffer[pos++] = c;
    }
    buffer[pos] = '\0';
    return pos > 0;
}

bool MemoryFS::findOldestSessionFast(String& outFilepath, unsigned long& outTimestamp) {
    if (!indexLoaded) {
        rebuildIndex();
    }
    
    unsigned long minTs = ULONG_MAX;
    String oldestFile = "";
    char lineBuf[512];

    for (const auto& pair : hashToIds) {
        uint16_t id = pair.second;
        String filepath = String(FS_SESSIONS_DIR) + "/" + String(id) + ".jsonl";
        File file = LittleFS.open(filepath, FILE_READ);
        if (!file) continue;

        if (!fastReadLine(file, lineBuf, sizeof(lineBuf))) {
            file.close();
            continue;
        }

        if (fastReadLine(file, lineBuf, sizeof(lineBuf))) {
            StaticJsonDocument<512> doc;
            if (!deserializeJson(doc, lineBuf)) {
                unsigned long ts = doc["timestamp"] | 0UL;
                if (ts > 0 && ts < minTs) {
                    minTs = ts;
                    oldestFile = filepath;
                }
            }
        }
        file.close();
    }

    if (minTs != ULONG_MAX && !oldestFile.isEmpty()) {
        outFilepath = oldestFile;
        outTimestamp = minTs;
        return true;
    }
    return false;
}

uint16_t MemoryFS::findPatientId(const String& name) {
    if (!indexLoaded) {
        rebuildIndex();
    }
    uint32_t h = hashName(name);
    auto range = hashToIds.equal_range(h);
    char lineBuf[384];
    
    for (auto it = range.first; it != range.second; ++it) {
        uint16_t candidateId = it->second;
        String filepath = String(FS_SESSIONS_DIR) + "/" + String(candidateId) + ".jsonl";
        
        File file = LittleFS.open(filepath, FILE_READ);
        if (file) {
            if (fastReadLine(file, lineBuf, sizeof(lineBuf))) {
                StaticJsonDocument<256> doc;
                if (!deserializeJson(doc, lineBuf)) {
                    String storedName = doc["name"].as<String>();
                    if (storedName == name) {
                        file.close();
                        return candidateId;
                    }
                }
            }
            file.close();
        }
    }
    return 0;
}

uint16_t MemoryFS::getOrCreatePatientId(const String& name) {
    uint16_t existingId = findPatientId(name);
    if (existingId != 0) {
        return existingId;
    }

    if (!LittleFS.exists(FS_SESSIONS_DIR)) {
        LittleFS.mkdir(FS_SESSIONS_DIR);
    }

    uint16_t newId = nextPatientId++;
    String filepath = String(FS_SESSIONS_DIR) + "/" + String(newId) + ".jsonl";
    Serial.printf("[MemoryFS] Creating new patient file: %s (Patient: %s)\n", filepath.c_str(), name.c_str());

    File file = LittleFS.open(filepath, FILE_WRITE);
    if (!file) {
        Serial.println("[MemoryFS] Error: Failed to create patient file!");
        return 0;
    }

    StaticJsonDocument<256> doc;
    doc["id"] = newId;
    doc["name"] = name;
    doc["createdAt"] = (unsigned long)time(nullptr);

    char lineBuf[384];
    size_t len = serializeJson(doc, lineBuf, sizeof(lineBuf) - 2);
    lineBuf[len++] = '\n';
    lineBuf[len] = '\0';

    file.write((const uint8_t*)lineBuf, len);
    file.close();

    hashToIds.insert({hashName(name), newId});
    return newId;
}

bool MemoryFS::saveSession(const SessionRecord& record) {
    if (!indexLoaded) {
        rebuildIndex();
    }
    checkAndCleanStorage();

    uint16_t id = getOrCreatePatientId(record.patientId);
    if (id == 0) {
        return false;
    }

    String filepath = String(FS_SESSIONS_DIR) + "/" + String(id) + ".jsonl";
    Serial.printf("[MemoryFS] Appending session to: %s\n", filepath.c_str());

    File file = LittleFS.open(filepath, FILE_APPEND);
    if (!file) {
        Serial.println("[MemoryFS] Error opening file for append!");
        return false;
    }

    StaticJsonDocument<512> doc;
    doc["timestamp"] = record.timestamp;
    doc["dateStr"] = record.dateStr;
    doc["minAngle"] = record.minAngle;
    doc["maxAngle"] = record.maxAngle;
    doc["amplitude"] = record.amplitude;
    doc["avgSpeed"] = record.avgSpeed;
    doc["smoothness"] = record.smoothness;
    doc["flexionsCount"] = record.flexionsCount;
    doc["holdingTime"] = record.holdingTime;

    char lineBuf[512];
    size_t len = serializeJson(doc, lineBuf, sizeof(lineBuf) - 2);
    lineBuf[len++] = '\n';
    lineBuf[len] = '\0';

    size_t written = file.write((const uint8_t*)lineBuf, len);
    file.close();

    Serial.println("[MemoryFS] Session saved directly to file.");
    return (written == len);
}

bool MemoryFS::rebuildIndex() {
    Serial.println("[MemoryFS] Rebuilding hash index from /p/*.jsonl files...");
    hashToIds.clear();
    nextPatientId = 1;

    if (!LittleFS.exists(FS_SESSIONS_DIR)) {
        LittleFS.mkdir(FS_SESSIONS_DIR);
        indexLoaded = true;
        return true;
    }

    File dir = LittleFS.open(FS_SESSIONS_DIR);
    if (!dir || !dir.isDirectory()) {
        indexLoaded = true;
        return true;
    }

    char lineBuf[384];
    File file = dir.openNextFile();
    while (file) {
        if (!file.isDirectory() && String(file.name()).endsWith(".jsonl")) {
            String filename = String(file.name());
            String idStr = filename;
            if (idStr.lastIndexOf('/') != -1) {
                idStr = idStr.substring(idStr.lastIndexOf('/') + 1);
            }
            idStr = idStr.substring(0, idStr.indexOf(".jsonl"));
            uint16_t fileId = (uint16_t)idStr.toInt();
            
            if (fileId >= nextPatientId) {
                nextPatientId = fileId + 1;
            }

            if (fastReadLine(file, lineBuf, sizeof(lineBuf))) {
                StaticJsonDocument<256> doc;
                if (!deserializeJson(doc, lineBuf) && doc.containsKey("name")) {
                    String patientName = doc["name"].as<String>();
                    hashToIds.insert({hashName(patientName), fileId});
                }
            }
        }
        file = dir.openNextFile();
    }
    
    Serial.printf("[MemoryFS] Hash index built successfully. Patients registered: %u, nextId: %u\n", 
                  (unsigned int)hashToIds.size(), nextPatientId);
    indexLoaded = true;
    return true;
}

std::vector<SessionRecord> MemoryFS::getAllSessions() {
    if (!indexLoaded) {
        rebuildIndex();
    }
    std::vector<SessionRecord> sessions;
    char lineBuf[512];

    for (const auto& pair : hashToIds) {
        uint16_t id = pair.second;
        String filepath = String(FS_SESSIONS_DIR) + "/" + String(id) + ".jsonl";
        File file = LittleFS.open(filepath, FILE_READ);
        if (!file) continue;

        if (!fastReadLine(file, lineBuf, sizeof(lineBuf))) {
            file.close();
            continue;
        }
        StaticJsonDocument<256> metaDoc;
        if (deserializeJson(metaDoc, lineBuf) || !metaDoc.containsKey("name")) {
            file.close();
            continue;
        }
        String patientName = metaDoc["name"].as<String>();

        while (fastReadLine(file, lineBuf, sizeof(lineBuf))) {
            StaticJsonDocument<512> doc;
            if (!deserializeJson(doc, lineBuf)) {
                SessionRecord rec;
                rec.patientId = patientName;
                rec.timestamp = doc["timestamp"] | 0UL;
                rec.filename = filepath + "#" + String(rec.timestamp);
                rec.dateStr = doc["dateStr"].as<String>();
                rec.minAngle = doc["minAngle"] | 0.0f;
                rec.maxAngle = doc["maxAngle"] | 0.0f;
                rec.amplitude = doc["amplitude"] | 0.0f;
                rec.avgSpeed = doc["avgSpeed"] | 0.0f;
                rec.smoothness = doc["smoothness"] | 0.0f;
                rec.flexionsCount = doc["flexionsCount"] | 0;
                rec.holdingTime = doc["holdingTime"] | 0.0f;
                
                sessions.push_back(rec);
            }
        }
        file.close();
    }

    std::sort(sessions.begin(), sessions.end(), [](const SessionRecord& a, const SessionRecord& b) {
        return a.timestamp < b.timestamp;
    });

    return sessions;
}

String MemoryFS::getSessionsJSON() {
    std::vector<SessionRecord> sessions = getAllSessions();
    
    String json = "{\"sessions\":[";
    for (size_t i = 0; i < sessions.size(); i++) {
        if (i > 0) json += ",";
        const SessionRecord& rec = sessions[i];
        
        char buf[512];
        snprintf(buf, sizeof(buf),
                 "{\"filename\":\"%s\",\"patientId\":\"%s\",\"timestamp\":%lu,\"dateStr\":\"%s\","
                 "\"minAngle\":%.1f,\"maxAngle\":%.1f,\"amplitude\":%.1f,\"avgSpeed\":%.1f,"
                 "\"smoothness\":%.1f,\"flexionsCount\":%d,\"holdingTime\":%.1f}",
                 rec.filename.c_str(), rec.patientId.c_str(), rec.timestamp, rec.dateStr.c_str(),
                 rec.minAngle, rec.maxAngle, rec.amplitude, rec.avgSpeed,
                 rec.smoothness, rec.flexionsCount, rec.holdingTime);
        json += buf;
    }
    json += "]}";
    return json;
}

size_t MemoryFS::getPatientsCount() {
    if (!indexLoaded) rebuildIndex();
    return hashToIds.size();
}

bool MemoryFS::getPatientSessionsChunk(size_t patientIndex, String& outJson) {
    if (!indexLoaded) rebuildIndex();
    if (patientIndex >= hashToIds.size()) return false;

    auto it = hashToIds.begin();
    std::advance(it, patientIndex);
    uint16_t id = it->second;

    String filepath = String(FS_SESSIONS_DIR) + "/" + String(id) + ".jsonl";
    File file = LittleFS.open(filepath, FILE_READ);
    if (!file) {
        outJson = "{\"type\":\"sessionsStreamChunk\",\"data\":[]}";
        return true;
    }

    char lineBuf[512];
    if (!fastReadLine(file, lineBuf, sizeof(lineBuf))) {
        file.close();
        outJson = "{\"type\":\"sessionsStreamChunk\",\"data\":[]}";
        return true;
    }

    StaticJsonDocument<256> metaDoc;
    if (deserializeJson(metaDoc, lineBuf) || !metaDoc.containsKey("name")) {
        file.close();
        outJson = "{\"type\":\"sessionsStreamChunk\",\"data\":[]}";
        return true;
    }
    String patientName = metaDoc["name"].as<String>();

    outJson = "{\"type\":\"sessionsStreamChunk\",\"data\":[";
    int items = 0;
    while (fastReadLine(file, lineBuf, sizeof(lineBuf))) {
        StaticJsonDocument<512> doc;
        if (!deserializeJson(doc, lineBuf)) {
            unsigned long ts = doc["timestamp"] | 0UL;
            String dateStr = doc["dateStr"].as<String>();
            float minAngle = doc["minAngle"] | 0.0f;
            float maxAngle = doc["maxAngle"] | 0.0f;
            float amplitude = doc["amplitude"] | 0.0f;
            float avgSpeed = doc["avgSpeed"] | 0.0f;
            float smoothness = doc["smoothness"] | 0.0f;
            int flexionsCount = doc["flexionsCount"] | 0;
            float holdingTime = doc["holdingTime"] | 0.0f;
            String recFilename = filepath + "#" + String(ts);

            if (items > 0) outJson += ",";

            char itemBuf[512];
            snprintf(itemBuf, sizeof(itemBuf),
                     "{\"filename\":\"%s\",\"patientId\":\"%s\",\"timestamp\":%lu,\"dateStr\":\"%s\","
                     "\"minAngle\":%.1f,\"maxAngle\":%.1f,\"amplitude\":%.1f,\"avgSpeed\":%.1f,"
                     "\"smoothness\":%.1f,\"flexionsCount\":%d,\"holdingTime\":%.1f}",
                     recFilename.c_str(), patientName.c_str(), ts, dateStr.c_str(),
                     minAngle, maxAngle, amplitude, avgSpeed, smoothness, flexionsCount, holdingTime);
            outJson += itemBuf;
            items++;
        }
    }
    file.close();
    outJson += "]}";
    return true;
}

String MemoryFS::generateCSV() {
    std::vector<SessionRecord> sessions = getAllSessions();
    String csv = "\uFEFFІм'я Пацієнта,Дата і Час,Мінімальний кут (град),Максимальний кут (град),Амплітуда (град),Середня швидкість (град/с),Плавність (%),Кількість згинань,Час утримання (с)\r\n";

    for (const auto& rec : sessions) {
        String cleanName = rec.patientId;
        cleanName.replace(",", " ");

        csv += cleanName + ",";
        csv += rec.dateStr + ",";
        csv += String(rec.minAngle, 2) + ",";
        csv += String(rec.maxAngle, 2) + ",";
        csv += String(rec.amplitude, 2) + ",";
        csv += String(rec.avgSpeed, 2) + ",";
        csv += String(rec.smoothness, 2) + ",";
        csv += String(rec.flexionsCount) + ",";
        csv += String(rec.holdingTime, 2) + "\r\n";
    }
    return csv;
}

bool MemoryFS::deletePatient(const String& patientId) {
    if (!indexLoaded) {
        rebuildIndex();
    }
    uint16_t id = findPatientId(patientId);
    if (id == 0) {
        return false;
    }

    String filepath = String(FS_SESSIONS_DIR) + "/" + String(id) + ".jsonl";
    if (LittleFS.exists(filepath)) {
        LittleFS.remove(filepath);
    }

    uint32_t h = hashName(patientId);
    auto range = hashToIds.equal_range(h);
    for (auto it = range.first; it != range.second; ) {
        if (it->second == id) {
            it = hashToIds.erase(it);
        } else {
            ++it;
        }
    }

    Serial.printf("[MemoryFS] Patient and file %s deleted completely\n", filepath.c_str());
    return true;
}

bool MemoryFS::deleteSession(const String& filenameOrKey, unsigned long timestamp) {
    if (!indexLoaded) {
        rebuildIndex();
    }

    String filepath = filenameOrKey;
    unsigned long targetTs = timestamp;

    if (filepath.indexOf('#') != -1) {
        if (targetTs == 0) {
            targetTs = filepath.substring(filepath.indexOf('#') + 1).toInt();
        }
        filepath = filepath.substring(0, filepath.indexOf('#'));
    }

    if (!LittleFS.exists(filepath)) {
        return false;
    }

    File source = LittleFS.open(filepath, FILE_READ);
    if (!source) return false;

    String tempPath = String(FS_SESSIONS_DIR) + "/temp.jsonl";
    File temp = LittleFS.open(tempPath, FILE_WRITE);
    if (!temp) {
        source.close();
        return false;
    }

    char lineBuf[512];

    if (fastReadLine(source, lineBuf, sizeof(lineBuf))) {
        size_t len = strlen(lineBuf);
        lineBuf[len++] = '\n';
        temp.write((const uint8_t*)lineBuf, len);
    }

    bool deleted = false;
    while (fastReadLine(source, lineBuf, sizeof(lineBuf))) {
        char parseBuf[512];
        strncpy(parseBuf, lineBuf, sizeof(parseBuf));
        parseBuf[sizeof(parseBuf) - 1] = '\0';

        StaticJsonDocument<512> doc;
        if (!deserializeJson(doc, parseBuf)) {
            unsigned long lineTs = doc["timestamp"] | 0UL;
            if (lineTs == targetTs && !deleted) {
                deleted = true;
                continue;
            }
        }
        size_t len = strlen(lineBuf);
        lineBuf[len++] = '\n';
        temp.write((const uint8_t*)lineBuf, len);
    }

    source.close();
    temp.close();

    if (deleted) {
        LittleFS.remove(filepath);
        LittleFS.rename(tempPath, filepath);
        Serial.printf("[MemoryFS] Session %lu deleted from file %s\n", targetTs, filepath.c_str());
    } else {
        LittleFS.remove(tempPath);
    }

    return deleted;
}

bool MemoryFS::checkAndCleanStorage() {
    if (getFreeBytes() >= FS_MIN_FREE_BYTES) {
        return false;
    }

    Serial.println("[MemoryFS] Low memory! Finding and deleting oldest session...");
    String oldestFile;
    unsigned long oldestTs = 0;
    if (findOldestSessionFast(oldestFile, oldestTs)) {
        return deleteSession(oldestFile, oldestTs);
    }
    return false;
}

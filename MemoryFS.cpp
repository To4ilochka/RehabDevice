#include "MemoryFS.h"

MemoryFS::MemoryFS() {}

bool MemoryFS::init() {
    Serial.println("[MemoryFS] Инициализация LittleFS...");
    
    // Пытаемся смонтировать LittleFS. Если не удается - форматируем при первом запуске
    if (!LittleFS.begin(true)) {
        Serial.println("[MemoryFS] Ошибка: Не удалось смонтировать LittleFS даже после попытки форматирования!");
        return false;
    }

    // Создаем директорию для сессий, если она отсутствует
    if (!LittleFS.exists("/sessions")) {
        LittleFS.mkdir("/sessions");
    }

    Serial.printf("[MemoryFS] LittleFS успешно смонтирована. Всего: %u КБ, Занято: %u КБ\n", 
                  getTotalBytes() / 1024, getUsedBytes() / 1024);
    return true;
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

bool MemoryFS::checkAndCleanStorage() {
    std::vector<SessionRecord> sessions;
    if (!loadIndex(sessions)) {
        return false;
    }

    bool cleaned = false;
    // Пока свободного места меньше порога (100 КБ) или превышено число сессий, удаляем самые старые
    while ((getFreeBytes() < FS_MIN_FREE_BYTES || sessions.size() >= FS_MAX_SESSIONS) && !sessions.empty()) {
        SessionRecord oldest = sessions.front();
        Serial.printf("[MemoryFS] Кольцевой буфер: удаление старой сессии %s (Пациент: %s)\n", 
                      oldest.filename.c_str(), oldest.patientId.c_str());
        
        if (LittleFS.exists(oldest.filename)) {
            LittleFS.remove(oldest.filename);
        }
        sessions.erase(sessions.begin());
        cleaned = true;
    }

    if (cleaned) {
        saveIndex(sessions);
    }
    return cleaned;
}

bool MemoryFS::saveSession(const SessionRecord& record) {
    // Перед записью проверяем и очищаем память при необходимости (кольцевой буфер)
    checkAndCleanStorage();

    // Обязательно гарантируем, что директория /sessions существует
    if (!LittleFS.exists("/sessions")) {
        LittleFS.mkdir("/sessions");
    }

    // Формируем безопасное ASCII-имя файла (без русских букв в пути, так как LittleFS на ESP32
    // возвращает ошибку при открытии файлов с кириллицей в названии).
    // Сам patientId ("Иван") при этом целиком и без изменений сохраняется внутри JSON и в индексе!
    String safeId = "";
    for (int i = 0; i < (int)record.patientId.length(); i++) {
        char c = record.patientId[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
            safeId += c;
        }
    }
    String filename = "/sessions/" + String(record.timestamp) + (safeId.length() > 0 ? ("_" + safeId) : "") + ".json";

    Serial.printf("[MemoryFS] Открытие файла на запись: %s (Пациент: %s)\n", filename.c_str(), record.patientId.c_str());

    // Сохраняем отдельный JSON-файл сессии
    File file = LittleFS.open(filename, FILE_WRITE);
    if (!file) {
        Serial.println("[MemoryFS] Ошибка: Не удалось создать файл сессии на запись!");
        return false;
    }

    StaticJsonDocument<512> doc;
    doc["filename"] = filename;
    doc["patientId"] = record.patientId;
    doc["timestamp"] = record.timestamp;
    doc["dateStr"] = record.dateStr;
    doc["minAngle"] = record.minAngle;
    doc["maxAngle"] = record.maxAngle;
    doc["amplitude"] = record.amplitude;
    doc["avgSpeed"] = record.avgSpeed;
    doc["smoothness"] = record.smoothness;
    doc["flexionsCount"] = record.flexionsCount;
    doc["holdingTime"] = record.holdingTime;

    if (serializeJson(doc, file) == 0) {
        Serial.println("[MemoryFS] Ошибка записи JSON в файл!");
        file.close();
        return false;
    }
    file.close();

    // Обновляем общий индекс сессий
    std::vector<SessionRecord> sessions;
    loadIndex(sessions);
    
    SessionRecord updatedRecord = record;
    updatedRecord.filename = filename;
    sessions.push_back(updatedRecord);
    
    saveIndex(sessions);
    
    Serial.printf("[MemoryFS] Сессия пациента '%s' успешно сохранена (%s)\n", 
                  record.patientId.c_str(), filename.c_str());
    return true;
}

bool MemoryFS::loadIndex(std::vector<SessionRecord>& sessions) {
    sessions.clear();
    if (!LittleFS.exists(FS_SESSIONS_INDEX_FILE)) {
        return true; // Индекс еще не создан
    }

    File file = LittleFS.open(FS_SESSIONS_INDEX_FILE, FILE_READ);
    if (!file) {
        return false;
    }

    DynamicJsonDocument doc(8192);
    DeserializationError error = deserializeJson(doc, file);
    file.close();

    if (error) {
        Serial.println("[MemoryFS] Ошибка чтения индекса сессий!");
        return false;
    }

    JsonArray arr = doc["sessions"].as<JsonArray>();
    for (JsonObject obj : arr) {
        SessionRecord rec;
        rec.filename = obj["filename"].as<String>();
        rec.patientId = obj["patientId"].as<String>();
        rec.timestamp = obj["timestamp"].as<unsigned long>();
        rec.dateStr = obj["dateStr"].as<String>();
        rec.minAngle = obj["minAngle"].as<float>();
        rec.maxAngle = obj["maxAngle"].as<float>();
        rec.amplitude = obj["amplitude"].as<float>();
        rec.avgSpeed = obj["avgSpeed"].as<float>();
        rec.smoothness = obj["smoothness"].as<float>();
        rec.flexionsCount = obj["flexionsCount"].as<int>();
        rec.holdingTime = obj["holdingTime"].as<float>();
        sessions.push_back(rec);
    }
    return true;
}

bool MemoryFS::saveIndex(const std::vector<SessionRecord>& sessions) {
    File file = LittleFS.open(FS_SESSIONS_INDEX_FILE, FILE_WRITE);
    if (!file) {
        return false;
    }

    DynamicJsonDocument doc(8192);
    JsonArray arr = doc.createNestedArray("sessions");

    for (const auto& rec : sessions) {
        JsonObject obj = arr.createNestedObject();
        obj["filename"] = rec.filename;
        obj["patientId"] = rec.patientId;
        obj["timestamp"] = rec.timestamp;
        obj["dateStr"] = rec.dateStr;
        obj["minAngle"] = rec.minAngle;
        obj["maxAngle"] = rec.maxAngle;
        obj["amplitude"] = rec.amplitude;
        obj["avgSpeed"] = rec.avgSpeed;
        obj["smoothness"] = rec.smoothness;
        obj["flexionsCount"] = rec.flexionsCount;
        obj["holdingTime"] = rec.holdingTime;
    }

    serializeJson(doc, file);
    file.close();
    return true;
}

std::vector<SessionRecord> MemoryFS::getAllSessions() {
    std::vector<SessionRecord> sessions;
    loadIndex(sessions);
    return sessions;
}

String MemoryFS::getSessionsJSON() {
    if (!LittleFS.exists(FS_SESSIONS_INDEX_FILE)) {
        return "{\"sessions\":[]}";
    }
    File file = LittleFS.open(FS_SESSIONS_INDEX_FILE, FILE_READ);
    if (!file) return "{\"sessions\":[]}";
    String json = file.readString();
    file.close();
    return json;
}

String MemoryFS::generateCSV() {
    std::vector<SessionRecord> sessions = getAllSessions();
    
    // Заголовок CSV (в формате с разделителями-запятыми и кодировкой UTF-8)
    String csv = "Имя Пациента,Дата и Время,Минимальный угол (град),Максимальный угол (град),Амплитуда (град),Средняя скорость (град/с),Плавность (%),Количество сгибаний,Время удержания (с)\r\n";

    for (const auto& rec : sessions) {
        String cleanName = rec.patientId;
        cleanName.replace(",", " "); // Убираем запятые внутри имени, чтобы не ломать CSV столбцы

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

bool MemoryFS::deleteSession(const String& filename) {
    if (LittleFS.exists(filename)) {
        LittleFS.remove(filename);
    }
    std::vector<SessionRecord> sessions;
    loadIndex(sessions);
    for (auto it = sessions.begin(); it != sessions.end(); ++it) {
        if (it->filename == filename) {
            sessions.erase(it);
            break;
        }
    }
    return saveIndex(sessions);
}

bool MemoryFS::formatFS() {
    Serial.println("[MemoryFS] Форматирование LittleFS...");
    return LittleFS.format();
}

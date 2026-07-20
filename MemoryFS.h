#ifndef MEMORY_FS_H
#define MEMORY_FS_H

#include <Arduino.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <vector>
#include <map>
#include <set>
#include <functional>
#include "Config.h"

// Структура сохраненной сессии (Аналитика пациента)
struct SessionRecord {
    String filename;         // Имя файла сессии в FS (например, /sessions/1752703344_John_Doe.json)
    String patientId;        // Ключ (Имя / Фамилия пациента)
    unsigned long timestamp; // Временная метка сессии (Unix timestamp)
    String dateStr;          // Форматированная строка даты/времени
    float minAngle;          // Минимальный угол
    float maxAngle;          // Максимальный угол
    float amplitude;         // Амплитуда движения
    float avgSpeed;          // Средняя скорость движения (град/сек)
    float smoothness;        // Плавность (индекс тремора/рывков)
    int flexionsCount;       // Количество сгибаний/поворотов
    float holdingTime;       // Время удержания в крайних точках (сек)
};

class MemoryFS {
public:
    MemoryFS();
    
    // Инициализация LittleFS и загрузка персистентного дерева
    bool init();
    
    // Получение общего объема памяти Flash в байтах
    size_t getTotalBytes();
    
    // Получение использованного объема памяти в байтах
    size_t getUsedBytes();
    
    // Получение свободной памяти в байтах
    size_t getFreeBytes();
    
    // Сохранение сессии с балансировкой Красно-Чёрного дерева
    bool saveSession(const SessionRecord& record);
    
    // Кольцевой буфер с мгновенной выборкой O(1) старого узла дерева
    bool checkAndCleanStorage();
    
    // Получение всех сессий из хронологического дерева O(N) без сортировки
    std::vector<SessionRecord> getAllSessions();
    
    // Генерация CSV строки/файла со всей накопленной статистикой пациента
    String generateCSV();
    
    // Получение JSON-списка сессий для веб-интерфейса
    String getSessionsJSON();

    // Потоковая выдача сессий чанками без нагрузки на RAM/Heap (Zero-Copy Streaming для WebSocket)
    void streamSessionsToCallback(std::function<void(const String&)> sendCallback);
    size_t getPatientsCount();
    bool getPatientSessionsChunk(size_t patientIndex, String& outJson);

    // Удаление конкретной записи (filename содержит /p/ID.jsonl#timestamp) или всего пациента
    bool deleteSession(const String& filenameOrKey, unsigned long timestamp = 0);
    bool deletePatient(const String& patientId);
    bool rebuildIndex();
    bool formatFS();

private:
    // Хэш-индекс в RAM: Ключ — 32-битный хэш (FNV-1a) от имени, Значение — числовой ID файла (/p/<ID>.jsonl)
    std::multimap<uint32_t, uint16_t> hashToIds;
    uint16_t nextPatientId;
    bool indexLoaded;

    // Вспомогательные методы хэширования и разрешения коллизий
    uint32_t hashName(const String& name);
    uint16_t findPatientId(const String& name);
    uint16_t getOrCreatePatientId(const String& name);
    
    // Быстрое буферизованное чтение строк (Zero-copy in-place парсинг без Heap-аллокаций)
    bool fastReadLine(File& file, char* buffer, size_t maxLen);
    
    // Мгновенный поиск самой старой записи за O(P) по пациентам (вдохновлено индексацией FlashDB TSDB)
    bool findOldestSessionFast(String& outFilepath, unsigned long& outTimestamp);

    bool loadIndex();
    bool saveIndexMetadata();
};

#endif // MEMORY_FS_H

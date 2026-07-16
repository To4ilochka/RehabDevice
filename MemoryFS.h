#ifndef MEMORY_FS_H
#define MEMORY_FS_H

#include <Arduino.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <vector>
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
    
    // Инициализация LittleFS
    bool init();
    
    // Получение общего объема памяти Flash в байтах
    size_t getTotalBytes();
    
    // Получение использованного объема памяти в байтах
    size_t getUsedBytes();
    
    // Получение свободной памяти в байтах
    size_t getFreeBytes();
    
    // Сохранение сессии в память с проверкой кольцевого буфера
    bool saveSession(const SessionRecord& record);
    
    // Логика кольцевого буфера: автоматическое удаление самых старых сессий при переполнении
    bool checkAndCleanStorage();
    
    // Получение списка всех сохраненных сессий (для дашборда врача)
    std::vector<SessionRecord> getAllSessions();
    
    // Генерация CSV строки/файла со всей накопленной статистикой пациента
    String generateCSV();
    
    // Получение JSON-списка сессий для веб-интерфейса
    String getSessionsJSON();

    // Удаление конкретной сессии или очистка всех данных
    bool deleteSession(const String& filename);
    bool formatFS();

private:
    bool loadIndex(std::vector<SessionRecord>& sessions);
    bool saveIndex(const std::vector<SessionRecord>& sessions);
};

#endif // MEMORY_FS_H

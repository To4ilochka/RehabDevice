#include <Arduino.h>
#include "Config.h"
#include "SensorMPU.h"
#include "MemoryFS.h"
#include "AnalyticsEngine.h"
#include "WiFiManagerModule.h"
#include "WebServerModule.h"

// Создание глобальных экземпляров модулей прошивки
SensorMPU sensor;
MemoryFS memoryFS;
AnalyticsEngine analytics;
WiFiManagerModule wifiManager;
WebServerModule webServer(&sensor, &memoryFS, &analytics, &wifiManager);

// Таймер для периодической отправки данных угла (30 FPS)
unsigned long lastWsBroadcastMs = 0;

void setup() {
    Serial.begin(115200);
    delay(500);

    Serial.println("====================================================================");
    Serial.println("  RehabDevice — Система мониторинга реабилитации кисти (ESP32)");
    Serial.println("====================================================================");

    // 1. Инициализация внутренней памяти и файловой системы LittleFS
    if (!memoryFS.init()) {
        Serial.println("[Setup] Ошибка: Не удалась инициализация MemoryFS!");
    }

    // 2. Инициализация гироскопа/акселерометра MPU6050 (DMP + прерывания INT)
    if (!sensor.init()) {
        Serial.println("[Setup] ВНИМАНИЕ: MPU6050 не инициализирован! Проверьте подключение.");
    }

    // 3. Инициализация Wi-Fi точки доступа и Captive Portal DNS сервера
    if (!wifiManager.init()) {
        Serial.println("[Setup] Ошибка: Не удалась инициализация WiFiManager!");
    }

    // 4. Запуск асинхронного веб-сервера и WebSockets
    webServer.init();

    Serial.println("====================================================================");
    Serial.println("  Система готова к работе! Подключитесь к Wi-Fi 'RehabDevice_AP'");
    Serial.println("====================================================================");
}

void loop() {
    // 1. Чтение пакетов из FIFO буфера датчика по аппаратному прерыванию без блокировки
    sensor.update();

    // 2. Обслуживание DNS-запросов для работы Captive Portal
    wifiManager.update();

    // 3. Очистка отключенных клиентов WebSocket
    webServer.cleanupClients();

    // 4. Получение новых данных датчика и расчет аналитики
    if (sensor.isReady()) {
        MPUData data = sensor.getData();
        if (data.dataUpdated) {
            // Передаем углы и скорости в аналитический движок для детекции тремора и сгибаний
            analytics.processData(data);

            // Отправка данных на фронтенд с заданной частотой (33 мс = ~30 Гц)
            unsigned long now = millis();
            if (now - lastWsBroadcastMs >= WS_BROADCAST_INTERVAL_MS) {
                lastWsBroadcastMs = now;
                
                // Трансляция текущего угла поворота кисти (крен / roll) на круг в браузере
                webServer.broadcastAngle(data.roll);
                
                // Трансляция живой аналитики, если идет активная сессия пациента
                webServer.broadcastLiveStats();
            }
        }
    }

    // Периодическая рассылка информации о статусе и памяти
    webServer.broadcastStatus();
}

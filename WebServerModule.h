#ifndef WEB_SERVER_MODULE_H
#define WEB_SERVER_MODULE_H

#include <Arduino.h>
#include <ESPAsyncWebServer.h>
#include <AsyncWebSocket.h>
#include <ArduinoJson.h>
#include <sys/time.h>
#include "Config.h"
#include "SensorMPU.h"
#include "MemoryFS.h"
#include "AnalyticsEngine.h"
#include "WiFiManagerModule.h"

class WebServerModule {
public:
    WebServerModule(SensorMPU* sensorPtr, MemoryFS* fsPtr, AnalyticsEngine* analyticsPtr, WiFiManagerModule* wifiPtr);
    
    // Инициализация маршрутов веб-сервера и WebSocket
    void init();
    
    // Отправка текущего угла поворота всем подключенным клиентам (в реальном времени)
    void broadcastAngle(float angle);
    
    // Отправка информации об использовании памяти, клиентах и состоянии сессии
    void broadcastStatus();
    
    // Отправка живой статистики текущей сессии
    void broadcastLiveStats();
    
    // Отправка списка сессий для построения графиков
    void sendSessionsList(AsyncWebSocketClient* client = nullptr);

    // Регулярный вызов из основного цикла loop() для безопасной отправки потоковых чанков на Core 1
    void update();

    // Отправка информации о статусе конкретному подключившемуся клиенту
    void sendStatusToClient(AsyncWebSocketClient* client);

    // Обработчик очистки неактивных клиентов WebSocket
    void cleanupClients();

private:
    AsyncWebServer server;
    AsyncWebSocket ws;

    SensorMPU* sensor;
    MemoryFS* memoryFS;
    AnalyticsEngine* analytics;
    WiFiManagerModule* wifi;

    unsigned long lastStatusBroadcastMs;
    unsigned long lastStatsBroadcastMs;
    unsigned long lastCleanupMs;

    struct StreamState {
        bool active = false;
        uint32_t clientId = 0;
        size_t currentPatientIdx = 0;
        bool headerSent = false;
    };
    StreamState streamState;
    uint32_t sendInitialStatusClientId;

    // Внутренние обработчики событий WebSocket
    void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type,
                   void* arg, uint8_t* data, size_t len);
    void handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len);

    // Обработчик Captive Portal и несуществующих страниц
    void setupRoutes();
};

#endif // WEB_SERVER_MODULE_H

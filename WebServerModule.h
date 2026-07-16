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

    // Внутренние обработчики событий WebSocket
    void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type,
                   void* arg, uint8_t* data, size_t len);
    void handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len);

    // Обработчик Captive Portal и несуществующих страниц
    void setupRoutes();
};

#endif // WEB_SERVER_MODULE_H

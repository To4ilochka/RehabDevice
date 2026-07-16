#ifndef WIFI_MANAGER_MODULE_H
#define WIFI_MANAGER_MODULE_H

#include <Arduino.h>
#include <WiFi.h>
#include <DNSServer.h>
#include "Config.h"

class WiFiManagerModule {
public:
    WiFiManagerModule();
    
    // Запуск точки доступа (SoftAP) и Captive Portal DNS сервера
    bool init();
    
    // Обслуживание DNS сервера в главном цикле (для работы Captive Portal)
    void update();
    
    // Получение IP-адреса точки доступа
    IPAddress getAPIP() const;
    
    // Получение количества активных подключенных клиентов
    int getConnectedClientsCount() const;

private:
    DNSServer dnsServer;
    IPAddress apIP;
};

#endif // WIFI_MANAGER_MODULE_H

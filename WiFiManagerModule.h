#ifndef WIFI_MANAGER_MODULE_H
#define WIFI_MANAGER_MODULE_H

#include <Arduino.h>
#include <WiFi.h>
#include <DNSServer.h>
#include "Config.h"

class WiFiManagerModule {
public:
    WiFiManagerModule();
    
    bool init();
    void update();
    int getConnectedClientsCount() const;

private:
    DNSServer dnsServer;
    IPAddress apIP;
};

#endif // WIFI_MANAGER_MODULE_H

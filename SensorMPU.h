#ifndef SENSOR_MPU_H
#define SENSOR_MPU_H

#include <Arduino.h>
#include <Wire.h>
#include "I2Cdev.h"
#include "MPU6050_6Axis_MotionApps20.h"
#include "Config.h"

// Структура для хранения текущих угловых данных и скоростей
struct MPUData {
    float pitch;        // Угол наклона кисти (в градусах)
    float roll;         // Угол крена (в градусах)
    float yaw;          // Угол рыскания (в градусах)
    float gyroX;        // Угловая скорость по X (град/сек)
    float gyroY;        // Угловая скорость по Y (град/сек)
    float gyroZ;        // Угловая скорость по Z (град/сек)
    float accelX;       // Ускорение по X (в g)
    float accelY;       // Ускорение по Y (в g)
    float accelZ;       // Ускорение по Z (в g)
    bool dataUpdated;   // Флаг получения нового пакета
    unsigned long timestamp; // Время последнего обновления (мс)
};

class SensorMPU {
public:
    SensorMPU();
    
    // Инициализация шины I2C, датчика и DMP
    bool init();
    
    // Беспрерывное (неблокирующее) чтение данных из FIFO буфера в основном цикле
    void update();
    
    // Автоматическая или ручная рекалибровка датчика "на лету"
    bool recalibrate();
    
    // Получение последних данных датчика
    MPUData getData();
    
    // Проверка статуса готовности датчика
    bool isReady() const;

    // Статический обработчик прерывания для attachInterrupt
    static void IRAM_ATTR dmpDataReadyISR();

private:
    MPU6050 mpu;
    bool dmpReady;
    uint8_t mpuIntStatus;
    uint8_t devStatus;
    uint16_t packetSize;
    uint16_t fifoCount;
    uint8_t fifoBuffer[64];

    // Кватернионы, векторы и углы Эйлера
    Quaternion q;
    VectorInt16 aa;
    VectorInt16 aaReal;
    VectorInt16 aaWorld;
    VectorFloat gravity;
    float ypr[3];

    // Смещения углов при ручной калибровке
    float pitchOffset;
    float rollOffset;
    float yawOffset;

    MPUData currentData;

    // Глобальный флаг прерывания
    static volatile bool mpuInterrupt;
};

#endif // SENSOR_MPU_H

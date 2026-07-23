#ifndef SENSOR_MPU_H
#define SENSOR_MPU_H

#include <Arduino.h>
#include <Wire.h>
#include "I2Cdev.h"
#include "MPU6050_6Axis_MotionApps20.h"
#include "Config.h"

struct MPUData {
    float pitch;
    float roll;
    float yaw;
    float gyroX;
    float gyroY;
    float gyroZ;
    float accelX;
    float accelY;
    float accelZ;
    bool dataUpdated;
    unsigned long timestamp;
};

class SensorMPU {
public:
    SensorMPU();
    
    bool init();
    void update();
    bool recalibrate();
    MPUData getData();
    bool isReady() const;

    static void IRAM_ATTR dmpDataReadyISR();

private:
    MPU6050 mpu;
    bool dmpReady;
    uint8_t mpuIntStatus;
    uint8_t devStatus;
    uint16_t packetSize;
    uint16_t fifoCount;
    uint8_t fifoBuffer[64];

    Quaternion q;
    VectorFloat gravity;
    float ypr[3];

    float pitchOffset;
    float rollOffset;
    float yawOffset;

    MPUData currentData;

    static volatile bool mpuInterrupt;
};

#endif // SENSOR_MPU_H

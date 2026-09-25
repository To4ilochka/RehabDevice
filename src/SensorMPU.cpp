#include "SensorMPU.h"
#include "AngleMath.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

extern TaskHandle_t sensorTaskHandle;

void IRAM_ATTR SensorMPU::dmpDataReadyISR() {
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    if (sensorTaskHandle != NULL) {
        vTaskNotifyGiveFromISR(sensorTaskHandle, &xHigherPriorityTaskWoken);
        if (xHigherPriorityTaskWoken) {
            portYIELD_FROM_ISR();
        }
    }
}

SensorMPU::SensorMPU() : dmpReady(false), mpuIntStatus(0), devStatus(0), packetSize(0), fifoCount(0),
                         pitchOffset(0.0f), rollOffset(0.0f), yawOffset(0.0f),
                         dataMutex(nullptr), mutexMissCount(0),
                         calState(CAL_IDLE), calWaitStartTime(0) {
    memset(&currentData, 0, sizeof(currentData));
    dataMutex = xSemaphoreCreateMutex();
    if (dataMutex == nullptr) {
        Serial.println("[SensorMPU] FATAL: Failed to create data mutex!");
    }
}

bool SensorMPU::init() {
    // Initialize I2C bus at 100 kHz for stability
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    delay(100);
    
    // Check WHO_AM_I register (0x75) to identify chip (MPU6050/6500/clone)
    Wire.beginTransmission(0x68);
    Wire.write(0x75);
    Wire.endTransmission(false);
    Wire.requestFrom((uint8_t)0x68, (uint8_t)1, (uint8_t)true);
    uint8_t whoAmI = Wire.read();
    Serial.printf("[SensorMPU] WHO_AM_I register (0x75) returned ID: 0x%02X\n", whoAmI);

    mpu.initialize();
    delay(50);
    
    bool conn = mpu.testConnection();
    if (!conn && whoAmI != 0x68 && whoAmI != 0x70 && whoAmI != 0x71 && whoAmI != 0x73 && whoAmI != 0x98) {
        Serial.printf("[SensorMPU] Error: MPU6050 not found (testConnection=false, whoAmI=0x%02X)!\n", whoAmI);
        return false;
    } else if (!conn) {
        Serial.printf("[SensorMPU] Warning: testConnection() returned false, but chip answered (ID 0x%02X). Continuing...\n", whoAmI);
    }

    Serial.println("[SensorMPU] Loading DMP firmware to MPU6050...");
    devStatus = mpu.dmpInitialize();

    mpu.setXGyroOffset(0);
    mpu.setYGyroOffset(0);
    mpu.setZGyroOffset(0);
    mpu.setZAccelOffset(1688);

    if (devStatus == 0) {
        Serial.println("[SensorMPU] Auto-calibrating gyro and accel...");
        mpu.CalibrateAccel(6);
        mpu.CalibrateGyro(6);
        mpu.PrintActiveOffsets();

        Serial.println("[SensorMPU] Enabling DMP...");
        mpu.setDMPEnabled(true);

        pinMode(PIN_MPU_INT, INPUT);
        attachInterrupt(digitalPinToInterrupt(PIN_MPU_INT), dmpDataReadyISR, RISING);

        mpuIntStatus = mpu.getIntStatus();
        packetSize = mpu.dmpGetFIFOPacketSize();
        dmpReady = true;

        // Switch I2C clock to 400 kHz for high-speed operation in main loop
        Wire.setClock(400000);
        mpu.resetFIFO();
        fifoCount = 0;

        Serial.println("[SensorMPU] DMP initialized successfully! Ready (400 kHz).");
        return true;
    } else {
        Serial.printf("[SensorMPU] DMP initialization error (code %d)\n", devStatus);
        return false;
    }
}

void SensorMPU::update() {
    if (!dmpReady) return;

    if (calState == CAL_WAITING_FIFO) {
        if (millis() - calWaitStartTime > 3000) {
            Serial.println("[SensorMPU] Recalibration timeout!");
            calState = CAL_IDLE;
            mpu.resetFIFO();
            return;
        }
        
        fifoCount = mpu.getFIFOCount();
        if (fifoCount < packetSize) return;

        uint8_t buffer[64];
        if (!mpu.dmpGetCurrentFIFOPacket(buffer)) {
            mpu.resetFIFO();
            calState = CAL_IDLE;
            return;
        }
        
        Quaternion tempQ;
        VectorFloat tempGravity;
        float tempYPR[3];
        mpu.dmpGetQuaternion(&tempQ, buffer);
        mpu.dmpGetGravity(&tempGravity, &tempQ);
        mpu.dmpGetYawPitchRoll(tempYPR, &tempQ, &tempGravity);

        if (!isfinite(tempYPR[0]) || !isfinite(tempYPR[1]) || !isfinite(tempYPR[2])) {
            mpu.resetFIFO();
            calState = CAL_IDLE;
            return;
        }

        yawOffset = tempYPR[0] * 180.0f / M_PI;
        pitchOffset = tempYPR[1] * 180.0f / M_PI;
        rollOffset = tempYPR[2] * 180.0f / M_PI;

        mpu.resetFIFO();
        fifoCount = 0;
        calState = CAL_IDLE;
        Serial.printf("[SensorMPU] Recalibration complete! New offsets: Y=%.2f, P=%.2f, R=%.2f\n", yawOffset, pitchOffset, rollOffset);
        return;
    }

    mpuIntStatus = mpu.getIntStatus();
    fifoCount = mpu.getFIFOCount();

    if ((mpuIntStatus & (0x01 << MPU6050_INTERRUPT_FIFO_OFLOW_BIT)) || fifoCount >= 1024) {
        mpu.resetFIFO();
        fifoCount = 0;
        Serial.println("[SensorMPU] Warning: FIFO overflow, buffer reset!");
        return;
    }

    if ((mpuIntStatus & 0x02) || fifoCount >= packetSize) {
        if (mpu.dmpGetCurrentFIFOPacket(fifoBuffer)) {
            fifoCount = mpu.getFIFOCount();

            mpu.dmpGetQuaternion(&q, fifoBuffer);

            float normSq = q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z;
            if (normSq < 0.5f || normSq > 1.5f || isnan(q.w) || isnan(q.x) || isnan(q.y) || isnan(q.z)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            mpu.dmpGetGravity(&gravity, &q);
            mpu.dmpGetYawPitchRoll(ypr, &q, &gravity);

            int16_t gx, gy, gz, ax, ay, az;
            mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

            float rawYaw = ypr[0] * 180.0f / M_PI;
            float rawPitch = ypr[1] * 180.0f / M_PI;
            float rawRoll = ypr[2] * 180.0f / M_PI;

            if (!isfinite(rawRoll) || !isfinite(rawPitch) || !isfinite(rawYaw)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            if (dataMutex != nullptr && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
                currentData.yaw = normalizeAngleDifference(rawYaw - yawOffset);
                currentData.pitch = normalizeAngleDifference(rawPitch - pitchOffset);
                currentData.roll = normalizeAngleDifference(rawRoll - rollOffset);

                // Convert gyro to deg/sec (131 LSB/deg/s) and accel to g (16384 LSB/g)
                currentData.gyroX = gx / 131.0f;
                currentData.gyroY = gy / 131.0f;
                currentData.gyroZ = gz / 131.0f;

                currentData.accelX = ax / 16384.0f;
                currentData.accelY = ay / 16384.0f;
                currentData.accelZ = az / 16384.0f;

                currentData.dataUpdated = true;
                currentData.timestamp = millis();
                xSemaphoreGive(dataMutex);
            } else if (dataMutex != nullptr) {
                __atomic_add_fetch(&mutexMissCount, 1, __ATOMIC_RELAXED);
            }
        }
    }
}

bool SensorMPU::recalibrate() {
    if (!dmpReady) return false;

    Serial.println("[SensorMPU] Performing on-the-fly recalibration...");
    
    mpu.resetFIFO();
    calState = CAL_WAITING_FIFO;
    calWaitStartTime = millis();

    return true;
}

MPUData SensorMPU::getData() {
    MPUData result;
    memset(&result, 0, sizeof(result));
    if (dataMutex != nullptr && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        result = currentData;
        currentData.dataUpdated = false;
        xSemaphoreGive(dataMutex);
    } else if (dataMutex != nullptr) {
        __atomic_add_fetch(&mutexMissCount, 1, __ATOMIC_RELAXED);
    }
    return result;
}

MPUData SensorMPU::peekData() {
    MPUData result;
    memset(&result, 0, sizeof(result));
    if (dataMutex != nullptr && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        result = currentData;
        xSemaphoreGive(dataMutex);
    } else if (dataMutex != nullptr) {
        __atomic_add_fetch(&mutexMissCount, 1, __ATOMIC_RELAXED);
    }
    return result;
}

bool SensorMPU::isReady() const {
    return dmpReady;
}

uint32_t SensorMPU::getMutexMissCount() const {
    return __atomic_load_n(&mutexMissCount, __ATOMIC_RELAXED);
}

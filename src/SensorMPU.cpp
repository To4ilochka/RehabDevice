#include "SensorMPU.h"
#include "AngleMath.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>

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
                         calState(CAL_IDLE), calWaitStartTime(0),
                         recalibratePending(false), recalibratedPendingSample(false) {
    memset(&currentData, 0, sizeof(currentData));
    setIdentityGravityRef();
    dataMutex = xSemaphoreCreateMutex();
    if (dataMutex == nullptr) {
        Serial.println("[SensorMPU] FATAL: Failed to create data mutex!");
    }
}

void SensorMPU::setIdentityGravityRef() {
    memset(gravRefMatrix, 0, sizeof(gravRefMatrix));
    gravRefMatrix[0] = 1.0f;
    gravRefMatrix[4] = 1.0f;
    gravRefMatrix[8] = 1.0f;
}

void SensorMPU::updateGravityRefFromVector(float gx, float gy, float gz) {
    const float norm = sqrtf(gx * gx + gy * gy + gz * gz);
    if (!isfinite(norm) || norm < 1e-4f) {
        setIdentityGravityRef();
        return;
    }

    const float x0 = gx / norm;
    const float y0 = gy / norm;
    const float z0 = gz / norm;

    // Shortest-arc Rodrigues rotation mapping unit gravity (x0, y0, z0) -> (0, 0, +1)
    // without introducing 6-axis gyro yaw drift into tilt axes.
    if (z0 > -0.9999f) {
        const float k = 1.0f / (1.0f + z0);
        gravRefMatrix[0] = 1.0f - k * x0 * x0;
        gravRefMatrix[1] = -k * x0 * y0;
        gravRefMatrix[2] = -x0;
        gravRefMatrix[3] = -k * x0 * y0;
        gravRefMatrix[4] = 1.0f - k * y0 * y0;
        gravRefMatrix[5] = -y0;
        gravRefMatrix[6] = x0;
        gravRefMatrix[7] = y0;
        gravRefMatrix[8] = z0;
    } else {
        // Sensor mounted upside-down (z0 ~= -1): 180-degree rotation around X-axis
        gravRefMatrix[0] = 1.0f;  gravRefMatrix[1] = 0.0f;  gravRefMatrix[2] = 0.0f;
        gravRefMatrix[3] = 0.0f;  gravRefMatrix[4] = -1.0f; gravRefMatrix[5] = 0.0f;
        gravRefMatrix[6] = 0.0f;  gravRefMatrix[7] = 0.0f;  gravRefMatrix[8] = -1.0f;
    }
}

void SensorMPU::computeCalibratedTilt(const VectorFloat& rawGrav, float& outPitchDeg, float& outRollDeg) const {
    const float norm = sqrtf(rawGrav.x * rawGrav.x + rawGrav.y * rawGrav.y + rawGrav.z * rawGrav.z);
    if (!isfinite(norm) || norm < 1e-4f) {
        outPitchDeg = 0.0f;
        outRollDeg = 0.0f;
        return;
    }

    const float gx = rawGrav.x / norm;
    const float gy = rawGrav.y / norm;
    const float gz = rawGrav.z / norm;

    const float cx = gravRefMatrix[0] * gx + gravRefMatrix[1] * gy + gravRefMatrix[2] * gz;
    const float cy = gravRefMatrix[3] * gx + gravRefMatrix[4] * gy + gravRefMatrix[5] * gz;
    const float cz = gravRefMatrix[6] * gx + gravRefMatrix[7] * gy + gravRefMatrix[8] * gz;

    outRollDeg = normalizeAngleDifference(atan2f(cy, cz) * (180.0f / static_cast<float>(M_PI)));
    outPitchDeg = normalizeAngleDifference(atan2f(cx, hypotf(cy, cz)) * (180.0f / static_cast<float>(M_PI)));
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

    #if MPU_USE_INTERRUPT
        pinMode(PIN_MPU_INT, INPUT);
        attachInterrupt(digitalPinToInterrupt(PIN_MPU_INT), dmpDataReadyISR, RISING);
        Serial.println("[SensorMPU] Acquisition mode: interrupt.");
    #else
        Serial.printf("[SensorMPU] Acquisition mode: polling (%u ms), INT not required.\n",
                  static_cast<unsigned>(MPU_POLL_INTERVAL_MS));
    #endif

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

    if (__atomic_exchange_n(&recalibratePending, false, __ATOMIC_ACQUIRE)) {
        mpu.resetFIFO();
        fifoCount = 0;
        calState = CAL_WAITING_FIFO;
        calWaitStartTime = millis();
        return;
    }

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
        mpu.dmpGetQuaternion(&tempQ, buffer);

        const float calNormSq = tempQ.w * tempQ.w + tempQ.x * tempQ.x + tempQ.y * tempQ.y + tempQ.z * tempQ.z;
        if (calNormSq < 0.5f || calNormSq > 1.5f || isnan(tempQ.w) || isnan(tempQ.x) || isnan(tempQ.y) || isnan(tempQ.z)) {
            mpu.resetFIFO();
            calState = CAL_IDLE;
            return;
        }

        mpu.dmpGetGravity(&tempGravity, &tempQ);
        const float rawYaw = atan2f(
            2.0f * tempQ.x * tempQ.y - 2.0f * tempQ.w * tempQ.z,
            2.0f * tempQ.w * tempQ.w + 2.0f * tempQ.x * tempQ.x - 1.0f
        ) * (180.0f / static_cast<float>(M_PI));

        if (!isfinite(rawYaw) || !isfinite(tempGravity.x) || !isfinite(tempGravity.y) || !isfinite(tempGravity.z)) {
            mpu.resetFIFO();
            calState = CAL_IDLE;
            return;
        }

        yawOffset = rawYaw;
        pitchOffset = atan2f(tempGravity.x, hypotf(tempGravity.y, tempGravity.z)) * (180.0f / static_cast<float>(M_PI));
        rollOffset = atan2f(tempGravity.y, tempGravity.z) * (180.0f / static_cast<float>(M_PI));
        updateGravityRefFromVector(tempGravity.x, tempGravity.y, tempGravity.z);
        recalibratedPendingSample = true;

        if (dataMutex != nullptr && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
            currentData.yaw = 0.0f;
            currentData.pitch = 0.0f;
            currentData.roll = 0.0f;
            xSemaphoreGive(dataMutex);
        }

        mpu.resetFIFO();
        fifoCount = 0;
        calState = CAL_IDLE;
        Serial.printf("[SensorMPU] Recalibration complete! Ref gravity=(%.3f, %.3f, %.3f), Y=%.2f, P=%.2f, R=%.2f\n",
                      tempGravity.x, tempGravity.y, tempGravity.z, yawOffset, pitchOffset, rollOffset);
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
            mpu.dmpGetQuaternion(&q, fifoBuffer);

            float normSq = q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z;
            if (normSq < 0.5f || normSq > 1.5f || isnan(q.w) || isnan(q.x) || isnan(q.y) || isnan(q.z)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            mpu.dmpGetGravity(&gravity, &q);

            int16_t gx, gy, gz, ax, ay, az;
            mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

            const float rawYaw = atan2f(
                2.0f * q.x * q.y - 2.0f * q.w * q.z,
                2.0f * q.w * q.w + 2.0f * q.x * q.x - 1.0f
            ) * (180.0f / static_cast<float>(M_PI));
            float calibratedPitch = 0.0f;
            float calibratedRoll = 0.0f;
            computeCalibratedTilt(gravity, calibratedPitch, calibratedRoll);

            if (!isfinite(calibratedRoll) || !isfinite(calibratedPitch) || !isfinite(rawYaw)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            if (dataMutex != nullptr && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
                currentData.yaw = normalizeAngleDifference(rawYaw - yawOffset);
                currentData.pitch = calibratedPitch;
                currentData.roll = calibratedRoll;

                // Convert gyro to deg/sec (131 LSB/deg/s) and accel to g (16384 LSB/g)
                currentData.gyroX = gx / 131.0f;
                currentData.gyroY = gy / 131.0f;
                currentData.gyroZ = gz / 131.0f;

                currentData.accelX = ax / 16384.0f;
                currentData.accelY = ay / 16384.0f;
                currentData.accelZ = az / 16384.0f;

                if (recalibratedPendingSample) {
                    currentData.recalibrated = true;
                    recalibratedPendingSample = false;
                }
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
    __atomic_store_n(&recalibratePending, true, __ATOMIC_RELEASE);

    return true;
}

MPUData SensorMPU::getData() {
    MPUData result;
    memset(&result, 0, sizeof(result));
    if (dataMutex != nullptr && xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        result = currentData;
        currentData.dataUpdated = false;
        currentData.recalibrated = false;
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

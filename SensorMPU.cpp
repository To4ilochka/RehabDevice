#include "SensorMPU.h"

// Инициализация статического флага прерывания
volatile bool SensorMPU::mpuInterrupt = false;

void IRAM_ATTR SensorMPU::dmpDataReadyISR() {
    mpuInterrupt = true;
}

SensorMPU::SensorMPU() : dmpReady(false), mpuIntStatus(0), devStatus(0), packetSize(0), fifoCount(0),
                         pitchOffset(0.0f), rollOffset(0.0f), yawOffset(0.0f) {
    memset(&currentData, 0, sizeof(currentData));
}

bool SensorMPU::init() {
    // Инициализация I2C шины с частотой 400 кГц
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
    
    // Инициализация MPU6050 по стандартному адресу 0x68
    mpu.initialize();
    
    // Проверка соединения с датчиком
    if (!mpu.testConnection()) {
        Serial.println("[SensorMPU] Ошибка: MPU6050 не обнаружен на шине I2C!");
        return false;
    }

    Serial.println("[SensorMPU] Загрузка DMP прошивки в MPU6050...");
    devStatus = mpu.dmpInitialize();

    // Установка начальных смещений гироскопа/акселерометра
    mpu.setXGyroOffset(0);
    mpu.setYGyroOffset(0);
    mpu.setZGyroOffset(0);
    mpu.setZAccelOffset(1688); // Заводская калибровка или авто-расчет

    if (devStatus == 0) {
        Serial.println("[SensorMPU] Автоматическая калибровка гироскопа и акселерометра...");
        mpu.CalibrateAccel(6);
        mpu.CalibrateGyro(6);
        mpu.PrintActiveOffsets();

        // Включение DMP
        Serial.println("[SensorMPU] Включение DMP...");
        mpu.setDMPEnabled(true);

        // Настройка аппаратного прерывания на пине ESP32
        pinMode(PIN_MPU_INT, INPUT);
        attachInterrupt(digitalPinToInterrupt(PIN_MPU_INT), dmpDataReadyISR, RISING);

        mpuIntStatus = mpu.getIntStatus();
        packetSize = mpu.dmpGetFIFOPacketSize();
        dmpReady = true;

        Serial.println("[SensorMPU] DMP успешно инициализирован! Готовность к работе.");
        return true;
    } else {
        Serial.printf("[SensorMPU] Ошибка инициализации DMP (код %d)\n", devStatus);
        return false;
    }
}

void SensorMPU::update() {
    if (!dmpReady) return;

    // Проверяем наличие прерывания от MPU или накопленных данных в FIFO
    if (!mpuInterrupt && mpu.getFIFOCount() < packetSize) {
        return;
    }

    // Сбрасываем флаг прерывания
    mpuInterrupt = false;
    mpuIntStatus = mpu.getIntStatus();
    fifoCount = mpu.getFIFOCount();

    // Проверка переполнения FIFO буфера
    if ((mpuIntStatus & (0x01 << MPU6050_INTERRUPT_FIFO_OFLOW_BIT)) || fifoCount >= 1024) {
        mpu.resetFIFO();
        Serial.println("[SensorMPU] Предупреждение: Переполнение FIFO, буфер сброшен!");
        return;
    }

    // Проверяем готовность пакета DMP
    if (mpuIntStatus & (0x01 << MPU6050_INTERRUPT_DMP_INT_BIT)) {
        // Дожидаемся полного пакета в буфере
        while (fifoCount < packetSize) {
            fifoCount = mpu.getFIFOCount();
        }

        // Читаем пакет из FIFO
        mpu.getFIFOBytes(fifoBuffer, packetSize);
        fifoCount -= packetSize;

        // Вычисляем кватернионы и углы Эйлера (в радианах, затем переводим в градусы)
        mpu.dmpGetQuaternion(&q, fifoBuffer);
        mpu.dmpGetGravity(&gravity, &q);
        mpu.dmpGetYawPitchRoll(ypr, &q, &gravity);

        // Читаем сырые значения гироскопа и акселерометра
        int16_t gx, gy, gz, ax, ay, az;
        mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

        // Расчет итоговых углов с учетом смещения рекалибровки
        float rawYaw = ypr[0] * 180.0f / M_PI;
        float rawPitch = ypr[1] * 180.0f / M_PI;
        float rawRoll = ypr[2] * 180.0f / M_PI;

        currentData.yaw = rawYaw - yawOffset;
        currentData.pitch = rawPitch - pitchOffset;
        currentData.roll = rawRoll - rollOffset;

        // Перевод гироскопа в град/сек (чувствительность MPU6050 ±250 deg/s по умолчанию -> 131 LSB/deg/s)
        currentData.gyroX = gx / 131.0f;
        currentData.gyroY = gy / 131.0f;
        currentData.gyroZ = gz / 131.0f;

        // Перевод ускорения в единицы g (±2g -> 16384 LSB/g)
        currentData.accelX = ax / 16384.0f;
        currentData.accelY = ay / 16384.0f;
        currentData.accelZ = az / 16384.0f;

        currentData.dataUpdated = true;
        currentData.timestamp = millis();
    }
}

bool SensorMPU::recalibrate() {
    if (!dmpReady) return false;

    Serial.println("[SensorMPU] Выполнение ручной рекалибровки на лету...");
    
    // Блокируем чтение FIFO на время перерасчета смещения
    mpuInterrupt = false;
    mpu.resetFIFO();

    // Ждем накопления стабильного пакета
    delay(50);
    uint16_t count = mpu.getFIFOCount();
    while (count < packetSize) {
        delay(10);
        count = mpu.getFIFOCount();
    }

    uint8_t buffer[64];
    mpu.getFIFOBytes(buffer, packetSize);
    
    Quaternion tempQ;
    VectorFloat tempGravity;
    float tempYPR[3];
    mpu.dmpGetQuaternion(&tempQ, buffer);
    mpu.dmpGetGravity(&tempGravity, &tempQ);
    mpu.dmpGetYawPitchRoll(tempYPR, &tempQ, &tempGravity);

    // Устанавливаем текущие углы в качестве нулевых смещений
    yawOffset = tempYPR[0] * 180.0f / M_PI;
    pitchOffset = tempYPR[1] * 180.0f / M_PI;
    rollOffset = tempYPR[2] * 180.0f / M_PI;

    mpu.resetFIFO();
    Serial.printf("[SensorMPU] Рекалибровка завершена! Новые смещения: Y=%.2f, P=%.2f, R=%.2f\n", yawOffset, pitchOffset, rollOffset);
    return true;
}

MPUData SensorMPU::getData() {
    currentData.dataUpdated = false;
    return currentData;
}

bool SensorMPU::isReady() const {
    return dmpReady;
}

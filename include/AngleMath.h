#ifndef ANGLE_MATH_H
#define ANGLE_MATH_H

constexpr float normalizeAngleDifference(float difference) {
    return difference > 180.0f ? difference - 360.0f
        : difference < -180.0f ? difference + 360.0f : difference;
}

#endif
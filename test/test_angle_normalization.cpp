#include "AngleMath.h"

static_assert(normalizeAngleDifference(-179.0f - 179.0f) == 2.0f, "Forward raw wrap");
static_assert(normalizeAngleDifference(179.0f - -179.0f) == -2.0f, "Reverse raw wrap");
static_assert(normalizeAngleDifference(180.0f - -180.0f) == 0.0f, "Equivalent endpoints");
static_assert(normalizeAngleDifference(-180.0f - 180.0f) == 0.0f, "Reverse endpoints");
static_assert(normalizeAngleDifference(180.0f) == 180.0f, "Positive half turn");
static_assert(normalizeAngleDifference(-180.0f) == -180.0f, "Negative half turn");
static_assert(normalizeAngleDifference(45.0f - 15.0f) == 30.0f, "Ordinary motion");

constexpr float calibratedBefore = normalizeAngleDifference(179.0f - 179.0f);
constexpr float calibratedAfter = normalizeAngleDifference(-179.0f - 179.0f);
static_assert(calibratedAfter - calibratedBefore == 2.0f, "Calibrated amplitude is two degrees");

constexpr float continuousForward = 179.0f + normalizeAngleDifference(-179.0f - 179.0f);
constexpr float continuousReverse = -179.0f + normalizeAngleDifference(179.0f - -179.0f);
static_assert(continuousForward == 181.0f, "Continuous positive joint angle");
static_assert(continuousReverse == -181.0f, "Continuous negative joint angle");
static_assert(continuousForward - 179.0f == 2.0f, "No false positive-wrap span");
static_assert(-179.0f - continuousReverse == 2.0f, "No false negative-wrap span");
static_assert(continuousForward + normalizeAngleDifference(179.0f - -179.0f) == 179.0f,
              "Return across wrap does not accumulate drift");
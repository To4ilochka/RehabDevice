export class StateManager {
    constructor() {
        this.state = {
            isAuthorized: false,
            currentPatientName: "",
            currentAppMode: 'monitor',
            allSessionsData: [],
            sessionsStatus: 'loading',
            globalSdAvailable: null,
            currentFirmwareVersion: "unknown",
            targetAngle: 0,
            calibMin: -20,
            calibMax: 20,
            isConnected: false,
            isHttpFallback: false,
            liveStats: null,
            memoryUsage: { used: 0, total: 1 }
        };
        this.listeners = {};
    }

    subscribe(key, callback) {
        if (!this.listeners[key]) {
            this.listeners[key] = [];
        }
        this.listeners[key].push(callback);
    }

    update(key, value) {
        if (this.state[key] !== value) {
            this.state[key] = value;
            this.notify(key, value);
        }
    }

    updateMultiple(updates) {
        let changed = false;
        for (const [key, value] of Object.entries(updates)) {
            if (this.state[key] !== value) {
                this.state[key] = value;
                this.notify(key, value);
                changed = true;
            }
        }
    }

    notify(key, value) {
        if (this.listeners[key]) {
            this.listeners[key].forEach(cb => cb(value, this.state));
        }
        if (this.listeners['*']) {
            this.listeners['*'].forEach(cb => cb(key, value, this.state));
        }
    }

    get(key) {
        return this.state[key];
    }
}

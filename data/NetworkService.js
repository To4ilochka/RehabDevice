export class NetworkService {
    constructor() {
        this.DEVICE_HOST = window.location.protocol + "//" + window.location.host;
        this.DEVICE_WS = "ws://" + window.location.host + "/ws";
        
        this.ws = null;
        this.usePolling = false;
        this.pollTimer = null;
        this.reconnectInterval = null;
        this.wsRecoveryTimer = null;
        this.wsReconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        
        this.messageHandlers = [];
        this.statusHandlers = [];
    }

    onMessage(handler) {
        this.messageHandlers.push(handler);
    }

    onStatusChange(handler) {
        this.statusHandlers.push(handler);
    }

    notifyStatus(isConnected, isHttpFallback) {
        this.statusHandlers.forEach(cb => cb(isConnected, isHttpFallback));
    }

    notifyMessage(data) {
        this.messageHandlers.forEach(cb => cb(data));
    }

    initConnection() {
        try {
            this.initWebSocket();
        } catch (e) {
            console.error("Exception in initConnection:", e);
        }

        setTimeout(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                console.warn("WebSocket not open after 8s, switching to polling.");
                this.switchToPolling();
            }
        }, 8000);
    }

    switchToPolling() {
        this.usePolling = true;
        if (this.ws) { 
            this.ws.onclose = null; 
            try { this.ws.close(); } catch(e) {} 
            this.ws = null; 
        }
        if (this.reconnectInterval) { 
            clearInterval(this.reconnectInterval); 
            this.reconnectInterval = null; 
        }
        this.startHttpPolling();
        this.startWebSocketReconnectCycle();
    }

    startHttpPolling() {
        this.notifyStatus(true, true);

        const localUnix = Math.floor(Date.now() / 1000) - (new Date().getTimezoneOffset() * 60);
        fetch(`${this.DEVICE_HOST}/api/cmd?action=syncTime&timestamp=${localUnix}`).catch(() => {});

        this.fetchAllSessionsPaginated();

        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => this.pollOnce(), 250);
    }

    pollOnce() {
        fetch(`${this.DEVICE_HOST}/api/status`)
            .then(r => r.json())
            .then(data => {
                this.notifyStatus(true, true);
                this.notifyMessage(data);
                if (data.angle !== undefined) {
                    this.notifyMessage({ type: "angle", angle: data.angle });
                }
            }).catch(() => {
                this.notifyStatus(false, true);
            });
    }

    initWebSocket() {
        this.ws = new WebSocket(this.DEVICE_WS);

        this.ws.onopen = () => {
            this.usePolling = false;
            this.wsReconnectAttempts = 0;
            this.notifyStatus(true, false);
            
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            if (this.wsRecoveryTimer) {
                clearTimeout(this.wsRecoveryTimer);
                this.wsRecoveryTimer = null;
            }
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }

            const localUnix = Math.floor(Date.now() / 1000) - (new Date().getTimezoneOffset() * 60);
            this.sendCommand("syncTime", { timestamp: localUnix });
            this.fetchAllSessionsPaginated();
        };

        this.ws.onerror = (error) => {
            console.error("WebSocket onerror:", error);
        };

        this.ws.onclose = () => {
            if (this.usePolling) return;
            this.ws = null;
            
            // Start polling immediately so UI shows connected status
            if (!this.pollTimer) {
                this.usePolling = true;
                this.startHttpPolling();
            }
            
            // Try to reconnect WebSocket in the background (limited attempts)
            this.startWebSocketReconnectCycle();
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleServerMessage(data);
            } catch (e) {}
        };
    }

    startWebSocketReconnectCycle() {
        if (this.reconnectInterval || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

        this.reconnectInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
                return;
            }
            if (this.wsReconnectAttempts >= this.maxReconnectAttempts) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
                console.log("Max WS reconnect attempts reached, staying on HTTP polling.");
                this.scheduleWebSocketRecovery();
                return;
            }
            this.tryReconnectWebSocket();
        }, 5000);
    }

    scheduleWebSocketRecovery() {
        if (this.wsRecoveryTimer) return;

        // Periodically retry after the bounded cycle so transient Wi-Fi issues do not make polling permanent.
        this.wsRecoveryTimer = setTimeout(() => {
            this.wsRecoveryTimer = null;
            this.wsReconnectAttempts = 0;
            this.tryReconnectWebSocket();
            this.startWebSocketReconnectCycle();
        }, 75000);
    }

    tryReconnectWebSocket() {
        this.wsReconnectAttempts++;
        try {
            const testWs = new WebSocket(this.DEVICE_WS);
            testWs.onopen = () => {
                // WebSocket reconnected successfully — switch back from polling
                this.wsReconnectAttempts = 0;
                if (this.pollTimer) {
                    clearInterval(this.pollTimer);
                    this.pollTimer = null;
                }
                if (this.reconnectInterval) {
                    clearInterval(this.reconnectInterval);
                    this.reconnectInterval = null;
                }
                if (this.wsRecoveryTimer) {
                    clearTimeout(this.wsRecoveryTimer);
                    this.wsRecoveryTimer = null;
                }
                if (this.ws) {
                    this.ws.onclose = null;
                    try { this.ws.close(); } catch(e) {}
                }
                this.ws = testWs;
                this.usePolling = false;
                this.notifyStatus(true, false);

                const localUnix = Math.floor(Date.now() / 1000) - (new Date().getTimezoneOffset() * 60);
                this.sendCommand("syncTime", { timestamp: localUnix });
                this.fetchAllSessionsPaginated();

                // Set up standard handlers
                testWs.onclose = () => {
                    this.ws = null;
                    if (!this.pollTimer) {
                        this.usePolling = true;
                        this.startHttpPolling();
                    }
                    this.startWebSocketReconnectCycle();
                };
                testWs.onerror = (e) => console.error("WS error:", e);
                testWs.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this.handleServerMessage(data);
                    } catch (e) {}
                };
            };
            testWs.onerror = () => {
                try { testWs.close(); } catch(e) {}
            };
        } catch (e) {}
    }

    handleServerMessage(data) {
        // WebSocket handles only real-time data (angle, status, liveStats)
        this.notifyMessage(data);
    }

    sendCommand(cmd, params) {
        if (!this.usePolling && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
        } else if (this.usePolling) {
            let url = `${this.DEVICE_HOST}/api/cmd?action=${encodeURIComponent(cmd)}`;
            if (params) {
                for (const [k, v] of Object.entries(params)) {
                    url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
                }
            }
            fetch(url).then(() => {
                setTimeout(() => this.pollOnce(), 400);
            }).catch(() => {});
        }
    }

    fetchAllSessionsPaginated() {
        if (this.sessionsRequest) return this.sessionsRequest;
        this.notifyMessage({ type: "sessionsLoading" });
        this.sessionsRequest = (async () => {
            const all = [];
            const limit = 50;
            let offset = 0;
            try {
                while (true) {
                    const response = await fetch(`${this.DEVICE_HOST}/api/sessions?offset=${offset}&limit=${limit}`);
                    if (!response.ok) throw new Error(`Sessions HTTP ${response.status}`);
                    const buffer = await response.arrayBuffer();
                    const data = msgpack.decode(new Uint8Array(buffer));
                    if (!Array.isArray(data)) throw new Error("Invalid sessions response");
                    all.push(...data);
                    if (data.length < limit) break;
                    offset += limit;
                }
                this.notifyMessage({ type: "sessionsComplete", sessions: all });
            } catch (error) {
                console.error("Sessions load failed:", error);
                this.notifyMessage({ type: "sessionsError" });
            }
        })().finally(() => { this.sessionsRequest = null; });
        return this.sessionsRequest;
    }
}

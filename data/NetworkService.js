export class NetworkService {
    constructor() {
        this.DEVICE_HOST = window.location.protocol + "//" + window.location.host;
        this.DEVICE_WS = "ws://" + window.location.host + "/ws";
        
        this.ws = null;
        this.usePolling = false;
        this.pollTimer = null;
        this.reconnectInterval = null;
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
    }

    startHttpPolling() {
        this.notifyStatus(true, true);

        const localUnix = Math.floor(Date.now() / 1000) - (new Date().getTimezoneOffset() * 60);
        fetch(`${this.DEVICE_HOST}/api/cmd?action=syncTime&timestamp=${localUnix}`).catch(() => {});

        this.fetchAllSessionsPaginated();

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
            this.notifyStatus(true, false);
            
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
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
            if (!this.reconnectInterval && this.wsReconnectAttempts < this.maxReconnectAttempts) {
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
                        return;
                    }
                    this.tryReconnectWebSocket();
                }, 5000);
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleServerMessage(data);
            } catch (e) {}
        };
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
                    // Don't retry after reconnected WS fails again — stay on polling
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
        // Sessions always loaded via HTTP REST MessagePack (never WebSocket)
        let all = [];
        let offset = 0;
        const limit = 50;
        
        const loadNextChunk = () => {
            fetch(`${this.DEVICE_HOST}/api/sessions?offset=${offset}&limit=${limit}`)
                .then(r => r.arrayBuffer())
                .then(buffer => {
                    let data = [];
                    try {
                        data = msgpack.decode(new Uint8Array(buffer));
                    } catch (e) {
                        console.error("MsgPack decode error:", e);
                        return;
                    }

                    if (!Array.isArray(data)) return;
                    all = all.concat(data);
                    
                    if (data.length === limit) {
                        offset += limit;
                        loadNextChunk();
                    } else {
                        this.notifyMessage({ type: "sessionsComplete", sessions: all });
                    }
                }).catch(e => console.error(e));
        };
        loadNextChunk();
    }
}
